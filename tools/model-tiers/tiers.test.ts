import { describe, expect, test } from "bun:test"

import {
  buildCandidates,
  buildTiers,
  effectiveCost,
  normalizeAAModels,
  resolvePinned,
  validateConfig,
  valuePerCost,
  type Candidate,
  type ChainEntry,
  type Config,
} from "./model-tiers.ts"
import { aaRow, baseConfig, pi } from "./fixtures.ts"

/** Build candidates the same way the CLI does, from raw AA rows plus a pi model list. */
function candidatesOf(
  rows: Record<string, unknown>[],
  piModels: ReturnType<typeof pi>[],
  config: Config = baseConfig(),
): Candidate[] {
  const models = normalizeAAModels(rows, config.capability.weights)
  return buildCandidates(models, piModels, config).candidates
}

function ids(entries: ChainEntry[]): string[] {
  return entries.map((e) => e.piId)
}

describe("tier thresholds", () => {
  const rows = [
    aaRow("Model A (max)", "model-a", { coding: 100, intelligence: 100, costPerTask: 5 }),
    aaRow("Model B (max)", "model-b", { coding: 96, intelligence: 96, costPerTask: 5 }),
    aaRow("Model C (max)", "model-c", { coding: 94, intelligence: 94, costPerTask: 5 }),
  ]
  const piModels = [pi("openai-codex", "model-a"), pi("opencode-go", "model-b"), pi("opencode-go", "model-c")]
  const config = baseConfig()

  test("cto keeps only models within 97% of the best capability", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const cto = chains.find((c) => c.tier === "cto")!
    expect(ids(cto.entries)).toEqual(["openai-codex/model-a:high"])
  })

  test("the 96% model joins lead but not cto", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const lead = chains.find((c) => c.tier === "lead")!
    // model-a is cto's top slot and is reserved from lower tiers
    expect(ids(lead.entries)).toEqual(["opencode-go/model-b:high", "opencode-go/model-c:high"])
  })

  test("a model that tops no tier stays inside the 55% intern floor", () => {
    // a/b/c/d top cto/lead/senior/dev and are reserved; e (50% of best, 55% floor of the pool left) is what is left
    const more = [
      ...rows,
      aaRow("Model D (max)", "model-d", { coding: 60, intelligence: 60, costPerTask: 1 }),
      aaRow("Model E (max)", "model-e", { coding: 50, intelligence: 50, costPerTask: 1 }),
    ]
    const pis = [...piModels, pi("google", "model-d"), pi("google", "model-e")]
    const { chains } = buildTiers(candidatesOf(more, pis, config), config)
    const intern = chains.find((c) => c.tier === "intern")!
    expect(ids(intern.entries)).toEqual(["google/model-e:low"])
  })

  test("a model that tops a higher tier is reserved from intern even inside its floor", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const intern = chains.find((c) => c.tier === "intern")!
    expect(ids(intern.entries)).toEqual([])
  })
})

describe("ranking rules", () => {
  test("lead breaks a capability tie on cost", () => {
    const rows = [
      aaRow("Apex (max)", "apex", { coding: 100, intelligence: 100, costPerTask: 9 }),
      aaRow("Pricey (max)", "pricey", { coding: 95, intelligence: 95, costPerTask: 9 }),
      aaRow("Cheap (max)", "cheap", { coding: 95, intelligence: 95, costPerTask: 2 }),
    ]
    const config = baseConfig()
    const chains = buildTiers(
      candidatesOf(rows, [pi("p0", "apex"), pi("p1", "pricey"), pi("p2", "cheap")], config),
      config,
    ).chains
    // apex alone fills cto and is reserved; 95% is below cto's 97% but inside lead's 92%
    const lead = chains.find((c) => c.tier === "lead")!
    expect(ids(lead.entries)).toEqual(["p2/cheap:high", "p1/pricey:high"])
  })

  test("senior ranks by capability per dollar", () => {
    const rows = [
      aaRow("Big (max)", "big", { coding: 90, intelligence: 90, costPerTask: 9 }),
      aaRow("Small (max)", "small", { coding: 90, intelligence: 90, costPerTask: 90 }),
    ]
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const chains = buildTiers(candidatesOf(rows, [pi("p1", "big"), pi("p1", "small")], config), config)
      .chains
    const senior = chains.find((c) => c.tier === "senior")!
    expect(ids(senior.entries)).toEqual(["p1/big:high", "p1/small:high"])
  })

  test("unknown cost sorts last instead of winning on cost per dollar", () => {
    const rows = [
      aaRow("Priced (max)", "priced", { coding: 90, intelligence: 90, costPerTask: 90 }),
      aaRow("Unpriced (max)", "unpriced", { coding: 90, intelligence: 90 }),
    ]
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const senior = buildTiers(candidatesOf(rows, [pi("p1", "priced"), pi("p2", "unpriced")], config), config)
      .chains.find((c) => c.tier === "senior")!
    expect(ids(senior.entries)).toEqual(["p1/priced:high", "p2/unpriced:high"])
    const unknown = senior.entries.find((e) => e.modelId === "unpriced")!
    expect(unknown.effectiveCost).toBeNull()
    expect(unknown.costBasis).toBe("unknown")
  })

  test("a free model is unbeatable per dollar, not a division by zero", () => {
    const rows = [
      aaRow("Free (max)", "free", { coding: 90, intelligence: 90, costPerTask: 0 }),
      aaRow("Paid (max)", "paid", { coding: 90, intelligence: 90, costPerTask: 1 }),
    ]
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const senior = buildTiers(candidatesOf(rows, [pi("p1", "free"), pi("p2", "paid")], config), config)
      .chains.find((c) => c.tier === "senior")!
    expect(ids(senior.entries)[0]).toBe("p1/free:high")
    expect(valuePerCost(senior.entries[0])).toBe(Infinity)
  })

  test("dev breaks a capability-per-dollar tie on speed", () => {
    const rows = [
      aaRow("Slow (max)", "slow", { coding: 90, intelligence: 90, costPerTask: 10, endToEnd: 40 }),
      aaRow("Fast (max)", "fast", { coding: 90, intelligence: 90, costPerTask: 10, endToEnd: 12 }),
    ]
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const dev = buildTiers(candidatesOf(rows, [pi("p1", "slow"), pi("p2", "fast")], config), config)
      .chains.find((c) => c.tier === "dev")!
    // same capability per dollar, so speed decides; "slow" would win the pi-id tail tie-break
    expect(ids(dev.entries)).toEqual(["p2/fast:medium", "p1/slow:medium"])
  })

  test("intern ranks by cost, not capability", () => {
    const rows = [
      aaRow("Weak (max)", "weak", { coding: 60, intelligence: 60, costPerTask: 0.5 }),
      aaRow("Strong (max)", "strong", { coding: 99, intelligence: 99, costPerTask: 8 }),
    ]
    const config = baseConfig({ escalation: { allow: true, scope: "model" } })
    const intern = buildTiers(candidatesOf(rows, [pi("p1", "weak"), pi("p2", "strong")], config), config)
      .chains.find((c) => c.tier === "intern")!
    expect(ids(intern.entries)).toEqual(["p1/weak:low", "p2/strong:low"])
  })
})

describe("subscription billing", () => {
  const rows = [
    aaRow("Sub (max)", "sub", { coding: 90, intelligence: 90, costPerTask: 4 }),
    aaRow("Metered (max)", "metered", { coding: 90, intelligence: 90, costPerTask: 2 }),
  ]
  const piModels = [pi("opencode-go", "sub"), pi("google", "metered")]

  test("a subscription model's cost is scaled down but never zero", () => {
    const config = baseConfig({
      escalation: { allow: true, scope: "model" },
      cost: { subscriptionWeight: 0.25, defaultBilling: "metered", providers: { "opencode-go": { billing: "subscription" } } },
    })
    expect(effectiveCost(config, 4, "opencode-go")).toBe(1)
    expect(effectiveCost(config, 2, "google")).toBe(2)
    const senior = buildTiers(candidatesOf(rows, piModels, config), config)
      .chains.find((c) => c.tier === "senior")!
    // 4 * 0.25 = 1 beats 2: the subscription model ranks first despite the higher sticker price
    expect(ids(senior.entries)).toEqual(["opencode-go/sub:high", "google/metered:high"])
  })

  test("a weight of 1 makes the ranking follow sticker price again", () => {
    const config = baseConfig({
      escalation: { allow: true, scope: "model" },
      cost: { subscriptionWeight: 1, defaultBilling: "metered", providers: { "opencode-go": { billing: "subscription" } } },
    })
    const senior = buildTiers(candidatesOf(rows, piModels, config), config)
      .chains.find((c) => c.tier === "senior")!
    expect(ids(senior.entries)).toEqual(["google/metered:high", "opencode-go/sub:high"])
  })

  test("a subscription weight of 0 is rejected by config validation", () => {
    const errors = validateConfig(
      baseConfig({ cost: { subscriptionWeight: 0, defaultBilling: "metered", providers: {} } }),
    )
    expect(errors.join(" ")).toContain("never 0")
  })
})

describe("never auto-escalate", () => {
  const rows = [aaRow("Kimi K3 (max)", "kimi-k3", { coding: 100, intelligence: 100, costPerTask: 5 })]
  const piModels = [pi("kimi-coding", "k3"), pi("opencode-go", "kimi-k3"), pi("openai-codex", "gpt-6-sol")]

  test("scope=model keeps a higher tier's top model out of every lower tier, on every provider", () => {
    const config = baseConfig({ aliases: { kimik3: ["kimi-coding/k3", "opencode-go/kimi-k3"] } })
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const cto = chains.find((c) => c.tier === "cto")!
    expect(ids(cto.entries)[0]).toBe("kimi-coding/k3:high")
    for (const tier of ["lead", "senior", "dev", "intern"]) {
      const chain = chains.find((c) => c.tier === tier)!
      expect(ids(chain.entries)).not.toContain("kimi-coding/k3:high")
      expect(ids(chain.entries)).not.toContain("opencode-go/kimi-k3:high")
    }
  })

  test("scope=entry reserves only the exact provider entry", () => {
    const config = baseConfig({
      aliases: { kimik3: ["kimi-coding/k3", "opencode-go/kimi-k3"] },
      escalation: { allow: false, scope: "entry" },
    })
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const lead = chains.find((c) => c.tier === "lead")!
    expect(ids(lead.entries)).not.toContain("kimi-coding/k3:high")
    expect(ids(lead.entries)).toContain("opencode-go/kimi-k3:high")
  })

  test("escalation.allow lifts the reservation", () => {
    const config = baseConfig({
      aliases: { kimik3: ["kimi-coding/k3", "opencode-go/kimi-k3"] },
      escalation: { allow: true, scope: "model" },
    })
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const lead = chains.find((c) => c.tier === "lead")!
    expect(ids(lead.entries)).toContain("kimi-coding/k3:high")
  })

  test("only the top slot is reserved, not the whole higher-tier chain", () => {
    const rows2 = [
      aaRow("Top (max)", "top", { coding: 100, intelligence: 100, costPerTask: 5 }),
      aaRow("Second (max)", "second", { coding: 99, intelligence: 99, costPerTask: 5 }),
    ]
    const config = baseConfig({ chainLength: 2 })
    const { chains } = buildTiers(candidatesOf(rows2, [pi("p1", "top"), pi("p2", "second")], config), config)
    expect(ids(chains.find((c) => c.tier === "cto")!.entries)).toEqual(["p1/top:high", "p2/second:high"])
    const lead = chains.find((c) => c.tier === "lead")!
    expect(ids(lead.entries)).toEqual(["p2/second:high"])
  })
})

describe("chain diversity", () => {
  const rows = [
    aaRow("Alpha (max)", "alpha", { coding: 100, intelligence: 100, costPerTask: 5 }),
    aaRow("Bravo (max)", "bravo", { coding: 99, intelligence: 99, costPerTask: 5 }),
    aaRow("Charlie (max)", "charlie", { coding: 98, intelligence: 98, costPerTask: 5 }),
    aaRow("Delta (max)", "delta", { coding: 97, intelligence: 97, costPerTask: 5 }),
  ]
  const piModels = [pi("opencode-go", "alpha"), pi("opencode-go", "bravo"), pi("opencode-go", "charlie"), pi("openai-codex", "delta")]

  test("a single-provider chain gains an entry from a second provider", () => {
    const config = baseConfig({ chainLength: 3 })
    const cto = buildTiers(candidatesOf(rows, piModels, config), config)
      .chains.find((c) => c.tier === "cto")!
    expect(ids(cto.entries)).toEqual(["opencode-go/alpha:high", "opencode-go/bravo:high", "openai-codex/delta:high"])
    expect(new Set(cto.entries.map((e) => e.provider)).size).toBe(2)
    expect(cto.diversity).toBe("ok")
    expect(cto.entries[2].reason).toContain("diversity swap-in")
  })

  test("a pool with only one provider is left alone and flagged", () => {
    const config = baseConfig({ chainLength: 3 })
    const cto = buildTiers(candidatesOf(rows, [pi("opencode-go", "alpha"), pi("opencode-go", "bravo")], config), config)
      .chains.find((c) => c.tier === "cto")!
    expect(cto.diversity).toBe("single-provider")
    expect(ids(cto.entries)).toEqual(["opencode-go/alpha:high", "opencode-go/bravo:high"])
  })

  test("a chain of one cannot be diverse", () => {
    const config = baseConfig({ chainLength: 1 })
    const cto = buildTiers(candidatesOf(rows, piModels, config), config)
      .chains.find((c) => c.tier === "cto")!
    expect(cto.diversity).toBe("chain-too-short")
    expect(ids(cto.entries)).toEqual(["opencode-go/alpha:high"])
  })

  test("the same model on two providers already counts as diverse", () => {
    const config = baseConfig({
      chainLength: 2,
      aliases: { alpha: ["opencode-go/alpha", "openai-codex/alpha"] },
    })
    const cto = buildTiers(candidatesOf(rows.slice(0, 1), [pi("opencode-go", "alpha"), pi("openai-codex", "alpha")], config), config)
      .chains.find((c) => c.tier === "cto")!
    expect(cto.diversity).toBe("ok")
    expect(ids(cto.entries)).toEqual(["openai-codex/alpha:high", "opencode-go/alpha:high"])
  })
})

describe("quota floors", () => {
  const rows = [
    aaRow("Rare (max)", "rare", { coding: 100, intelligence: 100, costPerTask: 5 }),
    aaRow("Plenty (max)", "plenty", { coding: 92, intelligence: 92, costPerTask: 5 }),
  ]
  const piModels = [pi("opencode-go", "rare"), pi("opencode-go", "plenty")]
  const config = baseConfig({
    escalation: { allow: true, scope: "model" },
    quota: {
      tiers: { cto: 0, dev: 1000, intern: 1000 },
      providers: {
        "opencode-go": {
          models: {
            rare: { requests_per_5h: 220 },
            plenty: { requests_per_5h: 6320 },
            unknown: { unlimited: true },
          },
        },
      },
    },
    tiers: {
      cto: { minCapabilityRatio: 0.97, rankBy: ["capability"], thinking: "high" },
      dev: { minCapabilityRatio: 0.9, rankBy: ["capability"], thinking: "medium" },
      intern: { minCapabilityRatio: 0.9, rankBy: ["cost"], thinking: "low" },
    },
  })

  test("a model under 1000 requests/5h can lead cto but not dev", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    expect(ids(chains.find((c) => c.tier === "cto")!.entries)).toEqual(["opencode-go/rare:high"])
    expect(ids(chains.find((c) => c.tier === "dev")!.entries)).toEqual(["opencode-go/plenty:medium"])
  })

  test("a documented cap is reported in the reason", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    const dev = chains.find((c) => c.tier === "dev")!
    expect(dev.entries[0].requestsPer5h).toBe(6320)
    expect(dev.entries[0].reason).toContain("6,320 req/5h")
  })

  test("a model with no documented cap is flagged as unknown, not excluded", () => {
    const unknownConfig = baseConfig({
      escalation: { allow: true, scope: "model" },
      quota: { tiers: { dev: 1000 }, providers: { "other": { models: { x: { requests_per_5h: 1 } } } } },
    })
    const chain = buildTiers(candidatesOf(rows, [pi("other", "rare"), pi("other", "plenty")], unknownConfig), unknownConfig)
      .chains.find((c) => c.tier === "dev")!
    expect(chain.entries).toHaveLength(2)
    expect(chain.entries[0].reason).toContain("quota unknown")
  })
})

describe("research axis", () => {
  const rows = [
    aaRow("Long (max)", "long", { coding: 70, intelligence: 70, costPerTask: 1 }),
    aaRow("Short (max)", "short", { coding: 95, intelligence: 95, costPerTask: 0.1 }),
  ]
  const config = baseConfig({
    research: { minContextTokens: 200_000, prefer: ["google/gemini-3.8-flash"] },
    tiers: {
      research: { axis: "context-cost", minCapabilityRatio: 0.5, rankBy: ["cost", "speed"], thinking: "off" },
    },
  })

  test("short-context models are dropped regardless of capability", () => {
    const piModels = [pi("google", "long", { contextTokens: 1_000_000 }), pi("google", "short", { contextTokens: 128_000 })]
    const chain = buildTiers(candidatesOf(rows, piModels, config), config)
      .chains.find((c) => c.tier === "research")!
    expect(ids(chain.entries)).toEqual(["google/long"])
  })

  test("the operator's preferred model is pinned first even when it costs more", () => {
    const rows2 = [
      aaRow("Gemini 3.8 Flash (max)", "gemini-3-8-flash", { coding: 70, intelligence: 70, costPerTask: 1.5 }),
      aaRow("Cheap (max)", "cheap", { coding: 70, intelligence: 70, costPerTask: 0.2 }),
    ]
    const piModels = [
      pi("google", "gemini-3.8-flash", { contextTokens: 1_000_000 }),
      pi("opencode-go", "cheap", { contextTokens: 1_000_000 }),
    ]
    const chain = buildTiers(candidatesOf(rows2, piModels, config), config)
      .chains.find((c) => c.tier === "research")!
    expect(ids(chain.entries)[0]).toBe("google/gemini-3.8-flash")
  })

  test("research still honours the capability sanity floor", () => {
    // the floor is relative to the best model in the pool, so a strong peer is needed
    const rows3 = [
      aaRow("Dumb (max)", "dumb", { coding: 10, intelligence: 10, costPerTask: 0.01 }),
      aaRow("Sharp (max)", "sharp", { coding: 90, intelligence: 90, costPerTask: 3 }),
    ]
    const piModels = [
      pi("opencode-go", "dumb", { contextTokens: 1_000_000 }),
      pi("opencode-go", "sharp", { contextTokens: 1_000_000 }),
    ]
    const chain = buildTiers(candidatesOf(rows3, piModels, config), config)
      .chains.find((c) => c.tier === "research")!
    expect(ids(chain.entries)).toEqual(["opencode-go/sharp"])
  })
})

describe("config validation", () => {
  test("an unknown rank key is rejected", () => {
    const config = baseConfig()
    config.tiers.dev.rankBy = ["vibes"]
    expect(validateConfig(config).join(" ")).toContain('unknown key "vibes"')
  })

  test("a quota floor for an unknown tier is rejected", () => {
    const config = baseConfig({ quota: { tiers: { ghost: 10 } } })
    expect(validateConfig(config).join(" ")).toContain("quota.tiers.ghost")
  })

  test("a sensible config passes", () => {
    expect(validateConfig(baseConfig())).toEqual([])
  })
})

describe("research.prefer without AA data", () => {
  const rows = [aaRow("Cheap (max)", "cheap", { coding: 70, intelligence: 70, costPerTask: 0.2 })]
  const config = baseConfig({
    research: { minContextTokens: 200_000, prefer: ["google/gemini-3.8-flash"] },
    tiers: { research: { axis: "context-cost", minCapabilityRatio: 0.5, rankBy: ["cost", "speed"], thinking: "off" } },
  })
  const piModels = [
    pi("google", "gemini-3.8-flash", { contextTokens: 1_000_000 }),
    pi("opencode-go", "cheap", { contextTokens: 1_000_000 }),
  ]

  test("a preferred model missing from AA is pinned first with blank metrics and a warning", () => {
    const candidates = candidatesOf(rows, piModels, config)
    const { pinned, warnings } = resolvePinned(config, piModels, candidates)
    expect(warnings.join(" ")).toContain("no Artificial Analysis data")
    const chain = buildTiers(candidates, config, [], pinned).chains[0]
    expect(ids(chain.entries)).toEqual(["google/gemini-3.8-flash", "opencode-go/cheap"])
    expect(chain.entries[0].capability).toBeNull()
    expect(chain.entries[0].reason).toContain("no Artificial Analysis data")
  })

  test("nothing is pinned twice when AA does cover the preferred model", () => {
    const rows2 = [...rows, aaRow("Gemini 3.8 Flash (max)", "g", { coding: 70, intelligence: 70, costPerTask: 1 })]
    const candidates = candidatesOf(rows2, piModels, config)
    const { pinned, warnings } = resolvePinned(config, piModels, candidates)
    expect(pinned).toEqual([])
    expect(warnings).toEqual([])
  })

  test("a preferred model pi does not have, a blocked one, and a short-context one are skipped", () => {
    const candidates = candidatesOf(rows, piModels.slice(1), config)
    expect(resolvePinned(config, piModels.slice(1), candidates).warnings.join(" ")).toContain("not in pi's registry")
    const blocked = { ...config, blocked: [{ match: "google/*", reason: "t" }] }
    expect(resolvePinned(blocked, piModels, candidates).pinned).toEqual([])
    const short = [pi("google", "gemini-3.8-flash", { contextTokens: 100_000 })]
    expect(resolvePinned(config, short, candidates).warnings.join(" ")).toContain("minContextTokens")
  })

  test("the pinned slot comes out of chainLength", () => {
    const cfg = { ...config, chainLength: 1 }
    const candidates = candidatesOf(rows, piModels, cfg)
    const { pinned } = resolvePinned(cfg, piModels, candidates)
    const chain = buildTiers(candidates, cfg, [], pinned).chains[0]
    expect(ids(chain.entries)).toEqual(["google/gemini-3.8-flash"])
  })
})
