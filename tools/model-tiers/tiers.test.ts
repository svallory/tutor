import { describe, expect, test } from "bun:test"

import {
  buildCandidates,
  buildTiers,
  effectiveCost,
  imputeCoding,
  injectAbsentModels,
  normalizeAAModels,
  parseEffort,
  rankingWarnings,
  renderDefaultsYaml,
  formatPinball,
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

  test("a model that tops no tier stays inside the 55% intern floor; one under it is out", () => {
    // a/b/c top cto/lead/senior; d (60% of the overall best) clears intern's floor, e (50%) does not
    const more = [
      ...rows,
      aaRow("Model D (max)", "model-d", { coding: 60, intelligence: 60, costPerTask: 1 }),
      aaRow("Model E (max)", "model-e", { coding: 50, intelligence: 50, costPerTask: 1 }),
    ]
    const pis = [...piModels, pi("google", "model-d"), pi("google", "model-e")]
    const { chains } = buildTiers(candidatesOf(more, pis, config), config)
    const intern = chains.find((c) => c.tier === "intern")!
    expect(ids(intern.entries)).toEqual(["google/model-d:low"])
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

  test("a model under 1000 requests/5h can be cto's primary but only a fallback in dev", () => {
    const { chains } = buildTiers(candidatesOf(rows, piModels, config), config)
    expect(ids(chains.find((c) => c.tier === "cto")!.entries)).toEqual(["opencode-go/rare:high"])
    const dev = chains.find((c) => c.tier === "dev")!
    // rare is more capable but sits under the 1000 floor: plenty leads, rare follows
    expect(ids(dev.entries)).toEqual(["opencode-go/plenty:medium", "opencode-go/rare:medium"])
    expect(dev.entries[0].fallbackOnly).toBe(false)
    expect(dev.entries[1].fallbackOnly).toBe(true)
    expect(dev.entries[1].reason).toContain("fallback only: 220 req/5h < 1000")
  })

  test("with no eligible primary the chain keeps its ranking and flags every entry", () => {
    const low = baseConfig({
      escalation: { allow: true, scope: "model" },
      quota: { tiers: { dev: 1000 }, providers: { "opencode-go": { models: { rare: { requests_per_5h: 5 }, plenty: { requests_per_5h: 6 } } } } },
    })
    const dev = buildTiers(candidatesOf(rows, piModels, low), low).chains.find((c) => c.tier === "dev")!
    expect(ids(dev.entries)).toEqual(["opencode-go/rare:medium", "opencode-go/plenty:medium"])
    expect(dev.entries.every((e) => e.fallbackOnly)).toBe(true)
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

describe("round 2: capability buckets", () => {
  const rows = [
    aaRow("Apex (max)", "apex", { coding: 100, intelligence: 100, costPerTask: 9 }),
    aaRow("Better (max)", "better", { coding: 90, intelligence: 90, costPerTask: 8 }),
    aaRow("Frugal (max)", "frugal", { coding: 89, intelligence: 89, costPerTask: 0.1 }),
    aaRow("Weaker (max)", "weaker", { coding: 80, intelligence: 80, costPerTask: 0.01 }),
  ]
  const pis = [pi("p0", "apex"), pi("p1", "better"), pi("p2", "frugal"), pi("p3", "weaker")]
  const tiers = {
    cto: { minCapabilityRatio: 0.99, rankBy: ["capability"], thinking: "high" },
    lead: { minCapabilityRatio: 0.7, rankBy: ["capability", "cost"], thinking: "high", capabilityBucket: 2 },
  } as Config["tiers"]

  test("within a bucket cost breaks the tie; outside it capability wins over cost", () => {
    const config = baseConfig({ tiers })
    const lead = buildTiers(candidatesOf(rows, pis, config), config).chains.find((c) => c.tier === "lead")!
    // better (90) and frugal (89) share a bucket -> cheaper frugal first; weaker is cheapest but a bucket down
    expect(ids(lead.entries)).toEqual(["p2/frugal:high", "p1/better:high", "p3/weaker:high"])
  })

  test("without a bucket the raw capability decides", () => {
    const config = baseConfig({ tiers: { ...tiers, lead: { ...tiers.lead, capabilityBucket: 0 } } })
    const lead = buildTiers(candidatesOf(rows, pis, config), config).chains.find((c) => c.tier === "lead")!
    expect(ids(lead.entries)).toEqual(["p1/better:high", "p2/frugal:high", "p3/weaker:high"])
  })
})

describe("round 2: ceiling for top models", () => {
  test("maxCapabilityRatio keeps the overall best out of a lower tier even when never a top slot", () => {
    const rows = [
      aaRow("Apex (max)", "apex", { coding: 100, intelligence: 100, costPerTask: 9 }),
      aaRow("Ace (max)", "ace", { coding: 95, intelligence: 95, costPerTask: 9 }),
      aaRow("Mid (max)", "mid", { coding: 80, intelligence: 80, costPerTask: 1 }),
    ]
    const config = baseConfig({
      tiers: {
        cto: { minCapabilityRatio: 0.99, rankBy: ["capability"], thinking: "high" },
        dev: { minCapabilityRatio: 0.7, maxCapabilityRatio: 0.9, rankBy: ["capability"], thinking: "medium" },
      },
    })
    const dev = buildTiers(candidatesOf(rows, [pi("p0", "apex"), pi("p1", "ace"), pi("p2", "mid")], config), config)
      .chains.find((c) => c.tier === "dev")!
    expect(ids(dev.entries)).toEqual(["p2/mid:medium"])
  })

  test("an out-of-range ceiling is rejected", () => {
    const config = baseConfig()
    config.tiers.dev.maxCapabilityRatio = 1.5
    expect(validateConfig(config).join(" ")).toContain("maxCapabilityRatio")
  })
})

describe("round 2: provider cost weight", () => {
  test("a provider weight overrides the subscription weight and stays positive", () => {
    const config = baseConfig({
      cost: { subscriptionWeight: 0.25, defaultBilling: "metered", providers: { claude: { billing: "subscription", weight: 0.9 }, "opencode-go": { billing: "subscription" } } },
    })
    expect(effectiveCost(config, 10, "claude")).toBeCloseTo(9)
    expect(effectiveCost(config, 10, "opencode-go")).toBeCloseTo(2.5)
    config.cost.providers.claude.weight = 0
    expect(validateConfig(config).join(" ")).toContain("cost.providers.claude.weight")
  })
})

describe("round 2: effort in descriptive names", () => {
  test("reads the effort out of AA's long parentheticals", () => {
    expect(parseEffort("Claude Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)")).toBe("max")
    expect(parseEffort("Claude Sonnet 5.5 (Adaptive Reasoning, Medium Effort, Default Fallback)")).toBe("medium")
    expect(parseEffort("DeepSeek V4 Flash 0731 (Reasoning, Max Effort)")).toBe("max")
    expect(parseEffort("Claude Opus 4.7 (Non-reasoning, High Effort)")).toBe("off")
    expect(parseEffort("Some Model (Preview)")).toBeNull()
  })
})

describe("round 2: coding index estimation", () => {
  // eight measured rows on the line coding = 20 + intelligence, +-1 alternating noise
  const measured = Array.from({ length: 8 }, (_, i) =>
    aaRow(`M${i} (max)`, `m${i}`, { intelligence: 20 + i * 5, coding: 40 + i * 5 + (i % 2 ? 1 : -1) }),
  )

  test("estimates a missing coding index, flags it, and stays below the fit", () => {
    const [target] = normalizeAAModels([...measured, aaRow("Bare (max)", "bare", { intelligence: 35 })].slice(-1), { coding: 0.6, intelligence: 0.4 })
    expect(target.codingIndex).toBeNull() // too few pairs on its own: untouched
    const all = normalizeAAModels([...measured, aaRow("Bare (max)", "bare", { intelligence: 35 })], { coding: 0.6, intelligence: 0.4 })
    const bare = all.find((m) => m.slug === "bare")!
    expect(bare.codingImputed).toBe(true)
    expect(bare.codingIndex!).toBeLessThan(55) // line says 55; one SD is subtracted
    expect(bare.codingIndex!).toBeGreaterThan(50)
    expect(bare.capability).toBeCloseTo(0.6 * bare.codingIndex! + 0.4 * 35)
    expect(all.find((m) => m.slug === "m0")!.codingImputed).toBeUndefined()
  })

  test("is clamped to the observed coding range instead of extrapolating", () => {
    const all = normalizeAAModels([...measured, aaRow("Huge (max)", "huge", { intelligence: 200 })], { coding: 0.6, intelligence: 0.4 })
    const observedMax = Math.max(...all.filter((m) => !m.codingImputed).map((m) => m.codingIndex!))
    expect(all.find((m) => m.slug === "huge")!.codingIndex).toBe(observedMax)
  })

  test("fewer than eight measured pairs means no estimate at all", () => {
    const few = normalizeAAModels([...measured.slice(0, 7), aaRow("Bare (max)", "bare", { intelligence: 35 })], { coding: 0.6, intelligence: 0.4 })
    const bare = few.find((m) => m.slug === "bare")!
    expect(bare.codingIndex).toBeNull()
    expect(bare.capability).toBe(35)
  })

  test("a row with neither index stays null", () => {
    const models = normalizeAAModels([...measured, aaRow("Blank (max)", "blank")], { coding: 0.6, intelligence: 0.4 })
    expect(models.find((m) => m.slug === "blank")!.capability).toBeNull()
  })

  test("identical intelligence values cannot be fitted", () => {
    const flat = Array.from({ length: 9 }, (_, i) => aaRow(`F${i} (max)`, `f${i}`, { intelligence: 30, coding: 40 + i }))
    const out = normalizeAAModels([...flat, aaRow("Bare (max)", "bare", { intelligence: 30 })], { coding: 0.6, intelligence: 0.4 })
    expect(out.find((m) => m.slug === "bare")!.codingIndex).toBeNull()
  })
})

describe("round 2: models AA does not carry", () => {
  const rows = [
    aaRow("Top (max)", "top", { coding: 100, intelligence: 100, costPerTask: 5 }),
    aaRow("Bottom (max)", "bottom", { coding: 60, intelligence: 60, costPerTask: 5 }),
  ]
  const config = baseConfig({
    aaAbsent: [{ name: "Ghost", between: ["top", "bottom"], fraction: 0.25, source: "operator ranking" }],
    aliases: { ghost: ["p9/ghost"] },
  })

  test("places the model a fraction of the way down between its neighbours, with a note", () => {
    const models = injectAbsentModels(normalizeAAModels(rows, config.capability.weights), config)
    const ghost = models.find((m) => m.baseKey === "ghost")!
    expect(ghost.capability).toBeCloseTo(90)
    expect(ghost.note).toContain("25% of the way")
    expect(ghost.costBasis).toBe("unknown")
  })

  test("defaults to the midpoint", () => {
    const cfg = baseConfig({ aaAbsent: [{ name: "Ghost", between: ["top", "bottom"], source: "s" }] })
    const ghost = injectAbsentModels(normalizeAAModels(rows, cfg.capability.weights), cfg).find((m) => m.baseKey === "ghost")!
    expect(ghost.capability).toBeCloseTo(80)
  })

  test("measured AA data wins, and a missing neighbour skips the injection", () => {
    const withReal = normalizeAAModels([...rows, aaRow("Ghost (max)", "ghost", { coding: 10, intelligence: 10 })], config.capability.weights)
    expect(injectAbsentModels(withReal, config)).toHaveLength(3)
    const lonely = normalizeAAModels(rows.slice(0, 1), config.capability.weights)
    expect(injectAbsentModels(lonely, config)).toHaveLength(1)
  })

  test("the injected model maps to its pi ids and competes, its note reaching the chain reason", () => {
    const models = injectAbsentModels(normalizeAAModels(rows, config.capability.weights), config)
    const { candidates } = buildCandidates(models, [pi("p0", "top"), pi("p1", "bottom"), pi("p9", "ghost")], config)
    // ghost is 90% of best: under lead's 92% floor, inside senior's 85%
    const lead = buildTiers(candidates, { ...config, escalation: { allow: true, scope: "model" } }).chains.find((c) => c.tier === "senior")!
    const ghost = lead.entries.find((e) => e.modelId === "ghost")!
    expect(ghost).toBeDefined()
    expect(ghost.reason).toContain("capability inferred")
  })
})

describe("round 2: operator ranking check", () => {
  const config = baseConfig({
    operatorRanking: [["*/astra", "claude/opus"], ["*/kimi", "kimi-coding/k3*"], ["*/sol"], ["google/gemini-*"]],
  })
  const entry = (provider: string, modelId: string, reason = "#1") =>
    ({ piId: `${provider}/${modelId}`, provider, modelId, reason }) as ChainEntry
  const chain = (tier: string, entries: ChainEntry[]) =>
    ({ tier, rule: "", floor: "", entries, poolSize: 0, diversity: "ok", reserved: [] }) as never

  test("a correctly ordered chain is silent", () => {
    expect(rankingWarnings([chain("lead", [entry("a", "astra"), entry("b", "kimi"), entry("c", "sol")])], config)).toEqual([])
  })

  test("each inverted pair warns, naming tier and both models", () => {
    const warnings = rankingWarnings([chain("dev", [entry("c", "sol"), entry("a", "astra"), entry("b", "kimi")])], config)
    expect(warnings).toEqual([
      "ranking: dev puts c/sol before a/astra, but the operator ranks astra above sol",
      "ranking: dev puts c/sol before b/kimi, but the operator ranks kimi above sol",
    ])
  })

  test("models in one group are equal, unranked models and provider variants of one model are ignored", () => {
    const equal = chain("x", [entry("claude", "opus"), entry("a", "astra")])
    const same = chain("y", [entry("kimi-coding", "k3"), entry("o", "kimi"), entry("kimi-coding", "k3-256k")])
    expect(rankingWarnings([equal, same], config)).toEqual([])
  })

  test("an unranked model warns once, however many chains carry it, and never breaks pair checks", () => {
    const one = chain("z", [entry("a", "astra"), entry("g", "mystery")])
    const two = chain("y", [entry("g", "mystery"), entry("a", "astra")])
    const warnings = rankingWarnings([one, two], config)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("g/mystery (first seen in z)")
    expect(warnings[0]).toContain("not in operatorRanking")
  })

  test("an unranked primary is named as such and a ranked model behind it is not misreported", () => {
    const warnings = rankingWarnings([chain("lead", [entry("g", "mystery"), entry("a", "astra")])], config)
    expect(warnings).toEqual([expect.stringContaining("as its primary")])
  })

  test("policy-placed free entries are exempt from every ranking check", () => {
    const free = { ...entry("o", "bunny"), freeSource: "leaderboard" } as ChainEntry
    expect(rankingWarnings([chain("lead", [free, entry("a", "astra")])], config)).toEqual([])
  })

  test("a ranked model behind a lower group is flagged even with gemini last", () => {
    const warnings = rankingWarnings([chain("r", [entry("google", "gemini-3.8-flash"), entry("c", "sol")])], config)
    expect(warnings).toHaveLength(1)
  })

  test("the operator's pinned research preference is exempt", () => {
    const pinned = entry("google", "gemini-3.8-flash", "operator preference (research.prefer), pinned first")
    expect(rankingWarnings([chain("research", [pinned, entry("c", "sol")])], config)).toEqual([])
  })

  test("no configured ranking means no warnings", () => {
    expect(rankingWarnings([chain("x", [entry("c", "sol"), entry("a", "astra")])], baseConfig())).toEqual([])
  })
})

describe("round 2: harness output", () => {
  const chains = [
    {
      tier: "cto", rule: "capability", floor: "f", poolSize: 1, diversity: "ok", reserved: [],
      entries: [
        { piId: "claude/opus", provider: "claude", modelId: "opus", thinking: null },
        { piId: "openai-codex/gpt-6-astra:high", provider: "openai-codex", modelId: "gpt-6-astra", thinking: "high" },
      ],
    },
  ] as never
  const meta = { generatedAt: "t", dataTimestamp: null, dataKind: "free", command: "c" }

  test("claude entries render as claude:<model>, pi entries keep pi:provider/model:thinking", () => {
    const yaml = renderDefaultsYaml(chains, { ...meta, harnesses: { claude: "claude" } })
    expect(yaml).toContain("  - claude:opus\n")
    expect(yaml).toContain("  - pi:openai-codex/gpt-6-astra:high\n")
  })

  test("without a harness map everything is pi", () => {
    expect(renderDefaultsYaml(chains, meta)).toContain("  - pi:claude/opus")
  })

  test("pinball skips providers that pi cannot run", () => {
    expect(formatPinball((chains as ReturnType<typeof Array>)[0], new Set(["claude"]))).toEqual([
      { provider: "openai-codex", id: "gpt-6-astra", thinking: "high" },
    ])
  })
})

describe("round 4: one best for floor and ceiling", () => {
  const rows = [
    aaRow("Apex (max)", "apex", { coding: 100, intelligence: 100, costPerTask: 9 }),
    aaRow("Ace (max)", "ace", { coding: 90, intelligence: 90, costPerTask: 9 }),
    aaRow("Mid (max)", "mid", { coding: 50, intelligence: 50, costPerTask: 1 }),
    aaRow("Low (max)", "low", { coding: 40, intelligence: 40, costPerTask: 1 }),
  ]
  const pis = [pi("p0", "apex"), pi("p1", "ace"), pi("p2", "mid"), pi("p3", "low")]
  const config = baseConfig({
    escalation: { allow: true, scope: "model" },
    tiers: {
      intern: { minCapabilityRatio: 0.55, maxCapabilityRatio: 0.8, rankBy: ["cost"], thinking: "low" },
    },
  })

  test("the floor is a share of the overall best, not of what the ceiling left behind", () => {
    const models = normalizeAAModels(rows, config.capability.weights)
    const { candidates } = buildCandidates(models, pis, config)
    const intern = buildTiers(candidates, config).chains[0]
    // floor 0.55 * 100 = 55, ceiling 80: nothing between; the compounded floor (0.55 * 50 = 27.5) would admit "low"
    expect(ids(intern.entries)).toEqual([])
  })

  test("both limits are advertised in the tier's floor text", () => {
    const models = normalizeAAModels(rows, config.capability.weights)
    const { candidates } = buildCandidates(models, pis, config)
    expect(buildTiers(candidates, config).chains[0].floor).toBe("capability >= 55% of best + capability <= 80% of best")
  })

  test("a model inside the band is admitted", () => {
    const more = [...rows, aaRow("Fit (max)", "fit", { coding: 70, intelligence: 70, costPerTask: 1 })]
    const models = normalizeAAModels(more, config.capability.weights)
    const { candidates } = buildCandidates(models, [...pis, pi("p4", "fit")], config)
    expect(ids(buildTiers(candidates, config).chains[0].entries)).toEqual(["p4/fit:low"])
  })
})

describe("round 4: unknown cost on a subscription", () => {
  const rows = [
    aaRow("Known (max)", "known", { coding: 90, intelligence: 90, costPerTask: 0.5 }),
    aaRow("Unknown (max)", "unknown", { coding: 90, intelligence: 90 }),
    aaRow("Unpriced (max)", "unpriced", { coding: 90, intelligence: 90 }),
  ]
  const pis = [pi("google", "known"), pi("kimi-coding", "unknown"), pi("google", "unpriced")]
  const tiers = { dev: { minCapabilityRatio: 0.5, rankBy: ["capability", "cost"], thinking: "medium", capabilityBucket: 2 } } as Config["tiers"]
  const cost = { subscriptionWeight: 0.25, defaultBilling: "metered", providers: { "kimi-coding": { billing: "subscription" } } } as Config["cost"]

  test("ranks ahead of a known metered price, and a metered unknown stays last", () => {
    const config = baseConfig({ tiers, cost, escalation: { allow: true, scope: "model" } })
    const models = normalizeAAModels(rows, config.capability.weights)
    const { candidates } = buildCandidates(models, pis, config)
    const dev = buildTiers(candidates, config).chains[0]
    expect(ids(dev.entries)).toEqual(["kimi-coding/unknown:medium", "google/known:medium", "google/unpriced:medium"])
    expect(dev.entries[0].reason).toContain("cost unknown (subscription)")
    expect(dev.entries[0].effectiveCost).toBeNull() // reported honestly, only the sort key moves
  })

  test("with no known metered price at all it sorts first without dividing by anything", () => {
    const config = baseConfig({ tiers, cost, escalation: { allow: true, scope: "model" } })
    const models = normalizeAAModels(rows.slice(1, 2), config.capability.weights)
    const { candidates } = buildCandidates(models, [pi("kimi-coding", "unknown")], config)
    expect(ids(buildTiers(candidates, config).chains[0].entries)).toEqual(["kimi-coding/unknown:medium"])
  })
})
