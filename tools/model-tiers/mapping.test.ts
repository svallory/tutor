import { describe, expect, test } from "bun:test"

import {
  buildCandidates,
  matchPiModels,
  normalizeAAModels,
  normalizeName,
  parseBaseName,
  parseEffort,
  parsePiModels,
  parseTokenCount,
  piIdFor,
  selectVariant,
} from "./model-tiers.ts"
import { PI_LIST_DUMP, aaRow, baseConfig, pi } from "./fixtures.ts"

const config = baseConfig()
const models = (rows: Record<string, unknown>[]) => normalizeAAModels(rows, config.capability.weights)

describe("pi model registry", () => {
  test("parses token counts with K/M suffixes", () => {
    expect(parseTokenCount("1.0M")).toBe(1_000_000)
    expect(parseTokenCount("1M")).toBe(1_000_000)
    expect(parseTokenCount("131.1K")).toBe(131_100)
    expect(parseTokenCount("128K")).toBe(128_000)
    expect(parseTokenCount("524.3K")).toBe(524_300)
    expect(parseTokenCount("junk")).toBeNull()
    expect(parseTokenCount(undefined)).toBeNull()
  })

  test("parses pi --list-models, skipping the header and keeping vendor-prefixed ids", () => {
    const parsed = parsePiModels(PI_LIST_DUMP)
    expect(parsed).toHaveLength(5)
    expect(parsed[0]).toEqual({
      provider: "google",
      id: "gemini-3.8-flash",
      contextTokens: 1_000_000,
      maxOutputTokens: 65_500,
      thinking: true,
      images: true,
    })
    const gptOss = parsed.find((m) => m.provider === "groq")
    expect(gptOss?.id).toBe("openai/gpt-oss-120b")
    expect(gptOss?.thinking).toBe(true)
    expect(gptOss?.images).toBe(false)
  })

  test("a model id containing a slash does not shift the numeric columns", () => {
    const [model] = parsePiModels("huggingface   deepseek-ai/DeepSeek-R1   1.0M   384K   yes   no")
    expect(model.provider).toBe("huggingface")
    expect(model.id).toBe("deepseek-ai/DeepSeek-R1")
    expect(model.contextTokens).toBe(1_000_000)
    expect(model.maxOutputTokens).toBe(384_000)
  })
})

describe("AA name parsing", () => {
  test("recognizes reasoning-effort markers", () => {
    expect(parseEffort("GPT-6 Sol (max)")).toBe("max")
    expect(parseEffort("GPT-6 Sol (xhigh)")).toBe("xhigh")
    expect(parseEffort("GPT-6 Sol (high)")).toBe("high")
    expect(parseEffort("GPT-5.6 Sol (Non-reasoning)")).toBe("off")
    expect(parseEffort("Qwen3.8 27B (low)")).toBe("low")
  })

  test("ignores parentheticals that are not effort markers", () => {
    expect(parseEffort("Qwen3.8 Max (0902)")).toBeNull()
    expect(parseEffort("Quasar 438B (max, based on GLM-5.2)")).toBeNull()
    expect(parseEffort("GLM 5.3 Flash")).toBeNull()
    expect(parseEffort("MiMo-V2.6-Pro")).toBeNull()
  })

  test("normalizes names to a comparable key", () => {
    expect(normalizeName("GPT-6.1 Sol (max)")).toBe("gpt61sol")
    expect(normalizeName("Kimi K3")).toBe("kimik3")
    expect(normalizeName("GLM 5.3 Flash")).toBe("glm53flash")
    expect(normalizeName("GPT-OSS 120B")).toBe("gptoss120b")
  })

  test("parseBaseName strips the effort marker and keeps a human label", () => {
    const parsed = parseBaseName("GPT-6 Sol (high)", "gpt-6-sol-high")
    expect(parsed.effort).toBe("high")
    expect(parsed.baseKey).toBe("gpt6sol")
    expect(parsed.baseLabel).toBe("GPT-6 Sol")
  })
})

describe("mapping AA models to pi models", () => {
  const piModels = [
    pi("openai-codex", "gpt-6-sol"),
    pi("kimi-coding", "k3"),
    pi("opencode-go", "kimi-k3"),
    pi("opencode-go", "glm-5.3"),
    pi("groq", "openai/gpt-oss-120b"),
  ]

  test("matches by normalized name", () => {
    const [model] = models([aaRow("GPT-6 Sol (high)", "gpt-6-sol-high", { coding: 60 })])
    expect(matchPiModels(model, piModels).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai-codex/gpt-6-sol",
    ])
  })

  test("matches a pi id that carries a vendor prefix", () => {
    const [model] = models([aaRow("GPT-OSS 120B", "gpt-oss-120b", { coding: 20 })])
    expect(matchPiModels(model, piModels).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "groq/openai/gpt-oss-120b",
    ])
  })

  test("an alias maps one AA model onto every provider that serves it", () => {
    const [model] = models([aaRow("Kimi K3 (max)", "kimi-k3", { coding: 60 })])
    const matched = matchPiModels(model, piModels, { kimik3: ["kimi-coding/k3", "opencode-go/kimi-k3"] })
    expect(matched.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "kimi-coding/k3",
      "opencode-go/kimi-k3",
    ])
  })

  test("normalized matching still finds the opencode-go entry when no alias exists", () => {
    const [model] = models([aaRow("Kimi K3 (max)", "kimi-k3", { coding: 60 })])
    expect(matchPiModels(model, piModels).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "opencode-go/kimi-k3",
    ])
  })

  test("an unmapped model is reported, not guessed", () => {
    const [model] = models([
      aaRow("Claude Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)", "claude-opus-5-5", {
        coding: 70,
      }),
    ])
    expect(matchPiModels(model, piModels)).toEqual([])
  })
})

describe("candidate building", () => {
  const piModels = [pi("openai-codex", "gpt-6-sol"), pi("opencode-go", "glm-5.3")]

  test("one candidate per provider/model, with every effort variant kept", () => {
    const rows = [
      aaRow("GPT-6 Sol (max)", "gpt-6-sol", { coding: 60, intelligence: 60 }),
      aaRow("GPT-6 Sol (high)", "gpt-6-sol-high", { coding: 55, intelligence: 55 }),
      aaRow("GLM-5.3 (max)", "glm-5-3", { coding: 50, intelligence: 50 }),
    ]
    const { candidates, unmapped } = buildCandidates(models(rows), piModels, baseConfig())
    expect(candidates).toHaveLength(2)
    expect(unmapped).toEqual([])
    const gpt = candidates.find((c) => c.baseId === "gpt-6-sol")
    // "(max)" is an effort marker, so the flagship row lives in the max slot; "none" is
    // reserved for rows with no effort marker at all (e.g. "GLM 5.3 Flash").
    expect([...(gpt?.variants.keys() ?? [])].sort()).toEqual(["high", "max"])
  })

  test("blocked models never become candidates and are reported", () => {
    const rows = [aaRow("GLM-5.3 (max)", "glm-5-3", { coding: 50 })]
    const config = baseConfig({ blocked: [{ match: "opencode-go/glm-*", reason: "region" }] })
    const { candidates, blocked } = buildCandidates(models(rows), piModels, config)
    expect(candidates).toHaveLength(0)
    expect(blocked).toEqual(["opencode-go/glm-5.3"])
  })

  test("a provider-wide block rule matches every model of that provider", () => {
    const rows = [aaRow("GLM-5.3 (max)", "glm-5-3", { coding: 50 })]
    const config = baseConfig({ blocked: [{ match: "opencode-go", reason: "no account" }] })
    expect(buildCandidates(models(rows), piModels, config).candidates).toHaveLength(0)
  })

  test("unmapped base models are listed once per base, not per effort variant", () => {
    const rows = [
      aaRow("Fable 5.1 (max)", "fable-5-1", { coding: 40 }),
      aaRow("Fable 5.1 (high)", "fable-5-1-high", { coding: 38 }),
    ]
    expect(buildCandidates(models(rows), piModels, baseConfig()).unmapped).toEqual(["Fable 5.1"])
  })
})

describe("variant selection and pi ids", () => {
  const rows = [
    aaRow("GPT-6 Sol (max)", "gpt-6-sol", { coding: 60, intelligence: 60 }),
    aaRow("GPT-6 Sol (high)", "gpt-6-sol-high", { coding: 55, intelligence: 55 }),
  ]
  const candidate = buildCandidates(models(rows), [pi("openai-codex", "gpt-6-sol")], baseConfig())
    .candidates[0]

  test("a tier's thinking level picks the AA row measured at that level", () => {
    const { model, from } = selectVariant(candidate, "high")
    expect(from).toBe("high")
    expect(model.slug).toBe("gpt-6-sol-high")
  })

  test("falls back to the flagship row when the exact level is not measured", () => {
    const { model, from } = selectVariant(candidate, "low")
    expect(from).toBe("max")
    expect(model.slug).toBe("gpt-6-sol")
  })

  test("a row with no effort marker is the flagship", () => {
    const plain = buildCandidates(
      models([aaRow("GLM 5.3 Flash", "glm-5-3-flash", { coding: 50 })]),
      [pi("opencode-go", "glm-5.3-flash")],
      baseConfig(),
    ).candidates[0]
    expect(selectVariant(plain, "high").from).toBe("flagship")
  })

  test("the thinking suffix is added only where pi supports it", () => {
    expect(piIdFor(candidate, "high").piId).toBe("openai-codex/gpt-6-sol:high")
    expect(piIdFor(candidate, "off").piId).toBe("openai-codex/gpt-6-sol")
    const noThinking = { ...candidate, supportsThinking: false }
    expect(piIdFor(noThinking, "high").piId).toBe("openai-codex/gpt-6-sol")
  })
})
