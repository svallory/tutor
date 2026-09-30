import { describe, expect, test } from "bun:test"

import {
  buildCandidates,
  buildTiers,
  formatJson,
  normalizeAAModels,
  resolveFreeModels,
  validateConfig,
  type Config,
  type FreeConfig,
} from "./model-tiers.ts"
import { aaRow, baseConfig, pi } from "./fixtures.ts"

const FREE: FreeConfig = {
  availableUntil: "unknown",
  excludeTiers: [],
  models: {
    "opencode-go/bunny": {
      position: "first-fallback",
      qualityOverride: { capability: 52.61, source: "test-source", speedSeconds: 1140 },
    },
    "opencode-go/paw": {
      position: "last",
      qualityOverride: { capability: 44.25, source: "test-source" },
    },
  },
}

const rows = [
  aaRow("Alpha (max)", "alpha", { coding: 100, intelligence: 100, costPerTask: 5 }),
  aaRow("Bravo (max)", "bravo", { coding: 90, intelligence: 90, costPerTask: 3 }),
  aaRow("Charlie (max)", "charlie", { coding: 80, intelligence: 80, costPerTask: 1 }),
  aaRow("Delta (max)", "delta", { coding: 70, intelligence: 70, costPerTask: 0.5 }),
]
const piModels = [
  pi("openai-codex", "alpha"),
  pi("openai-codex", "bravo"),
  pi("google", "charlie"),
  pi("google", "delta"),
  pi("opencode-go", "bunny"),
  pi("opencode-go", "paw"),
]

function run(overrides: Partial<Config> = {}) {
  const config = baseConfig({
    escalation: { allow: true, scope: "model" },
    free: FREE,
    ...overrides,
  })
  const models = normalizeAAModels(rows, config.capability.weights)
  const { candidates } = buildCandidates(models, piModels, config)
  const { free } = resolveFreeModels(config, piModels)
  return { config, chains: buildTiers(candidates, config, free).chains }
}

const ids = (chain: { entries: { piId: string }[] }) => chain.entries.map((e) => e.piId)

describe("free-model policy", () => {
  test("first fallback sits right after the primary, the last-resort model closes the chain", () => {
    const { chains } = run()
    for (const chain of chains.filter((c) => c.entries.length > 0)) {
      const list = ids(chain)
      expect(list[1]).toStartWith("opencode-go/bunny")
      expect(list[list.length - 1]).toStartWith("opencode-go/paw")
    }
  })

  test("the chain stays within chainLength: free slots are carved out of the ranked part", () => {
    const { chains } = run({ chainLength: 3 })
    const dev = chains.find((c) => c.tier === "dev")!
    expect(dev.entries).toHaveLength(3)
    expect(ids(dev).map((id) => id.split(":")[0])).toEqual([
      expect.stringMatching(/^(openai-codex|google)\//),
      "opencode-go/bunny",
      "opencode-go/paw",
    ])
  })

  test("free entries cost 0, are flagged free, carry the source and an unknown end date", () => {
    const { chains } = run()
    const bunny = chains[0].entries.find((e) => e.modelId === "bunny")!
    expect(bunny.billing).toBe("free")
    expect(bunny.cost).toBe(0)
    expect(bunny.effectiveCost).toBe(0)
    expect(bunny.costBasis).toBe("free")
    expect(bunny.capability).toBe(52.61)
    expect(bunny.freeSource).toBe("test-source")
    expect(bunny.availableUntil).toBe("unknown")
    expect(bunny.requestsPer5h).toBe(Infinity)
    expect(bunny.speedSeconds).toBe(1140)
    expect(bunny.speedBasis).toBe("external-estimate")
    expect(bunny.reason).toContain("available until unknown")
    const paw = chains[0].entries.find((e) => e.modelId === "paw")!
    expect(paw.speedBasis).toBe("unknown")
  })

  test("a free model that pi can run never competes in the ranked pool", () => {
    // give the free model an AA row that would beat everyone; it must still not top a tier
    const config = baseConfig({ escalation: { allow: true, scope: "model" }, free: FREE })
    const withRow = [...rows, aaRow("Bunny (max)", "bunny", { coding: 200, intelligence: 200, costPerTask: 0.01 })]
    const models = normalizeAAModels(withRow, config.capability.weights)
    const { candidates } = buildCandidates(models, piModels, config)
    const { free } = resolveFreeModels(config, piModels)
    const cto = buildTiers(candidates, config, free).chains.find((c) => c.tier === "cto")!
    expect(ids(cto)[0]).toStartWith("openai-codex/alpha")
    expect(ids(cto).filter((id) => id.startsWith("opencode-go/bunny"))).toHaveLength(1)
  })

  test("excludeTiers keeps a tier free of free fallbacks", () => {
    const { chains } = run({ free: { ...FREE, excludeTiers: ["cto"] } })
    expect(ids(chains.find((c) => c.tier === "cto")!).some((id) => id.startsWith("opencode-go/"))).toBe(false)
    expect(ids(chains.find((c) => c.tier === "dev")!).some((id) => id.startsWith("opencode-go/bunny"))).toBe(true)
  })

  test("an empty ranked chain still gets its free models, and nothing is reserved for them", () => {
    const onlyFree = [pi("opencode-go", "bunny"), pi("opencode-go", "paw")]
    const config = baseConfig({ escalation: { allow: false, scope: "model" }, free: FREE })
    const { free } = resolveFreeModels(config, onlyFree)
    const { chains, reserved } = buildTiers([], config, free)
    expect(ids(chains[0])).toEqual(["opencode-go/bunny:high", "opencode-go/paw:high"])
    expect(reserved.size).toBe(0)
  })

  test("free providers count towards diversity but cannot fake it", () => {
    // ranked part is all openai-codex; the free (opencode-go) tail makes the chain span 2 providers
    const codexOnly = [pi("openai-codex", "alpha"), pi("openai-codex", "bravo"), pi("opencode-go", "bunny"), pi("opencode-go", "paw")]
    const config = baseConfig({ escalation: { allow: true, scope: "model" }, free: FREE, chainLength: 4 })
    const models = normalizeAAModels(rows, config.capability.weights)
    const { candidates } = buildCandidates(models, codexOnly, config)
    const { free } = resolveFreeModels(config, codexOnly)
    const dev = buildTiers(candidates, config, free).chains.find((c) => c.tier === "dev")!
    expect(dev.diversity).toBe("ok")
    // all-opencode-go world: two free models add one provider, still single
    const goOnly = [pi("opencode-go", "alpha"), pi("opencode-go", "bunny"), pi("opencode-go", "paw")]
    const { candidates: c2 } = buildCandidates(models, goOnly, config)
    const { free: f2 } = resolveFreeModels(config, goOnly)
    expect(buildTiers(c2, config, f2).chains.find((c) => c.tier === "cto")!.diversity).toBe("single-provider")
  })

  test("a free model missing from pi or blocked by config is reported and skipped", () => {
    const config = baseConfig({
      free: FREE,
      blocked: [{ match: "opencode-go/paw", reason: "test" }],
    })
    const { free, warnings } = resolveFreeModels(config, [pi("opencode-go", "paw")])
    expect(free).toEqual([])
    expect(warnings.join(" ")).toContain("opencode-go/bunny is not in pi's registry")
    expect(warnings.join(" ")).toContain("opencode-go/paw is blocked by config")
  })

  test("no free config means no free entries", () => {
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const models = normalizeAAModels(rows, config.capability.weights)
    const { candidates } = buildCandidates(models, piModels, config)
    const { free } = resolveFreeModels(config, piModels)
    expect(free).toEqual([])
    const cto = buildTiers(candidates, config, free).chains[0]
    expect(ids(cto).some((id) => id.includes("bunny"))).toBe(false)
  })

  test("json output carries the free source and end date", () => {
    const { chains } = run()
    const json = formatJson(chains, {
      dataKind: "offline", dataTimestamp: null, models: 0, piModels: 0, candidates: 0,
      unmapped: 0, unmappedModels: [], blockedModels: [], warnings: [],
    })
    const metric = json.metrics.cto.find((m) => m.piId.startsWith("opencode-go/bunny"))!
    expect(metric.freeSource).toBe("test-source")
    expect(metric.availableUntil).toBe("unknown")
    expect(metric.requestsPer5h).toBe("unlimited")
    expect(metric.billing).toBe("free")
  })
})

describe("free config validation", () => {
  test("rejects a bad position, a missing source, duplicates and unknown excluded tiers", () => {
    const bad = baseConfig({
      free: {
        availableUntil: "unknown",
        excludeTiers: ["ghost"],
        models: {
          "a/one": { position: "middle" as never, qualityOverride: { capability: 1, source: "s" } },
          "a/two": { position: "last", qualityOverride: { capability: 1, source: "" } },
          "a/three": { position: "last", qualityOverride: { capability: 1, source: "s" } },
        },
      },
    })
    const text = validateConfig(bad).join("\n")
    expect(text).toContain('free.models.a/one.position must be "first-fallback" or "last"')
    expect(text).toContain("free.models.a/two.qualityOverride needs a numeric capability and a source note")
    expect(text).toContain('at most one model may take position "last"')
    expect(text).toContain("free.excludeTiers.ghost")
  })

  test("a valid free block passes", () => {
    expect(validateConfig(baseConfig({ free: FREE }))).toEqual([])
  })
})
