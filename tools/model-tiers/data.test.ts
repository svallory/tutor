import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cacheFile,
  cacheIsFresh,
  computeCapability,
  computeCost,
  computeSpeed,
  formatPinball,
  formatTable,
  loadAADataset,
  normalizeAAModels,
  parseArgs,
  readCache,
  renderDefaultsYaml,
  writeCache,
  type ChainEntry,
  type Config,
  type TierChain,
} from "./model-tiers.ts"
import { aaRow, baseConfig } from "./fixtures.ts"

let dir: string
let config: Config

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-tiers-data-"))
  config = baseConfig()
  config.api.cacheDir = join(dir, "cache")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const W = { coding: 0.6, intelligence: 0.4 }

describe("computeCapability", () => {
  test("weighted blend of coding and intelligence", () => {
    const value = computeCapability(
      { artificial_analysis_coding_index: 80, artificial_analysis_intelligence_index: 50 },
      W,
    )
    expect(value).toBeCloseTo(0.6 * 80 + 0.4 * 50)
  })

  test("renormalizes over the indices that are present", () => {
    expect(computeCapability({ artificial_analysis_intelligence_index: 50 }, W)).toBe(50)
    expect(computeCapability({ artificial_analysis_coding_index: 70 }, W)).toBe(70)
  })

  test("no index at all is null, not 0", () => {
    expect(computeCapability({}, W)).toBeNull()
    expect(computeCapability(undefined, W)).toBeNull()
  })

  test("software_engineering joins the blend and the weights renormalize", () => {
    const weights = { coding: 0.45, intelligence: 0.3, software_engineering: 0.25 }
    const value = computeCapability(
      {
        artificial_analysis_coding_index: 80,
        artificial_analysis_intelligence_index: 60,
        software_engineering: 40,
      },
      weights,
    )
    expect(value).toBeCloseTo(0.45 * 80 + 0.3 * 60 + 0.25 * 40)
    // absent -> the same weights collapse onto the other two
    const without = computeCapability(
      { artificial_analysis_coding_index: 80, artificial_analysis_intelligence_index: 60 },
      weights,
    )
    expect(without).toBeCloseTo((0.45 * 80 + 0.3 * 60) / 0.75)
  })

  test("accepts the software_engineering_index spelling and ignores non-numbers", () => {
    const value = computeCapability(
      { artificial_analysis_coding_index: "80", software_engineering_index: 40 },
      { coding: 0.5, software_engineering: 0.5 },
    )
    expect(value).toBe(40)
  })

  test("a zero weight drops that index", () => {
    expect(
      computeCapability(
        { artificial_analysis_coding_index: 90, artificial_analysis_intelligence_index: 10 },
        { coding: 1, intelligence: 0 },
      ),
    ).toBe(90)
  })
})

describe("computeCost", () => {
  test("prefers cost per Intelligence-Index task", () => {
    expect(computeCost(aaRow("x", "x", { costPerTask: 2.5, blended: 9 }))).toEqual({ cost: 2.5, basis: "per-task" })
  })

  test("falls back to the blended 3:1 price and flags it", () => {
    expect(computeCost(aaRow("x", "x", { blended: 4 }))).toEqual({ cost: 4, basis: "blended-token-price" })
  })

  test("computes a 3:1 blend from input/output when nothing else exists", () => {
    expect(computeCost(aaRow("x", "x", { input: 1, output: 5 }))).toEqual({ cost: 2, basis: "computed-token-price" })
  })

  test("only one of input/output is not enough", () => {
    expect(computeCost(aaRow("x", "x", { input: 1 }))).toEqual({ cost: null, basis: "unknown" })
  })

  test("a genuine zero cost per task is kept as 0", () => {
    expect(computeCost(aaRow("x", "x", { costPerTask: 0 }))).toEqual({ cost: 0, basis: "per-task" })
  })
})

describe("computeSpeed", () => {
  test("end-to-end time wins", () => {
    expect(computeSpeed(aaRow("x", "x", { endToEnd: 12, tps: 100, outputTokens: 5000 }))).toEqual({
      speedSeconds: 12,
      basis: "end-to-end",
    })
  })

  test("otherwise tokens per task divided by throughput", () => {
    expect(computeSpeed(aaRow("x", "x", { tps: 100, outputTokens: 5000 }))).toEqual({
      speedSeconds: 50,
      basis: "tokens-per-task",
    })
  })

  test("throughput alone yields an inverse estimate", () => {
    expect(computeSpeed(aaRow("x", "x", { tps: 50 }))).toEqual({ speedSeconds: 0.02, basis: "throughput-inverse" })
  })

  test("nothing usable is unknown, and a zero throughput is ignored", () => {
    expect(computeSpeed(aaRow("x", "x"))).toEqual({ speedSeconds: null, basis: "unknown" })
    expect(computeSpeed(aaRow("x", "x", { tps: 0 }))).toEqual({ speedSeconds: null, basis: "unknown" })
  })
})

describe("normalizeAAModels envelopes", () => {
  const rows = [aaRow("Alpha (max)", "alpha", { coding: 90, intelligence: 80 })]

  test("live/free envelope, llms.json envelope and bare array all normalize the same", () => {
    const shapes = [{ data: rows }, { status: 200, data: rows, fetchedAt: "2026-09-01" }, rows]
    for (const shape of shapes) {
      const [m] = normalizeAAModels(shape, W)
      expect(m.slug).toBe("alpha")
      expect(m.effort).toBe("max")
      expect(m.baseKey).toBe("alpha")
    }
  })

  test("rows without a string name or slug and non-objects are skipped", () => {
    const junk = [null, 7, "x", { name: "no slug" }, { slug: "no-name" }, ...rows]
    expect(normalizeAAModels(junk, W)).toHaveLength(1)
  })

  test("garbage payloads yield an empty list", () => {
    expect(normalizeAAModels(null, W)).toEqual([])
    expect(normalizeAAModels({ data: "nope" }, W)).toEqual([])
    expect(normalizeAAModels(42, W)).toEqual([])
  })
})

describe("cache", () => {
  test("cacheIsFresh honours the TTL and rejects future or garbage stamps", () => {
    const now = Date.parse("2026-09-29T12:00:00Z")
    expect(cacheIsFresh(config, "2026-09-29T08:00:00Z", now)).toBe(true) // 4h < 12h
    expect(cacheIsFresh(config, "2026-09-28T20:00:00Z", now)).toBe(false) // 16h
    expect(cacheIsFresh(config, "2026-09-29T20:00:00Z", now)).toBe(false) // future
    expect(cacheIsFresh(config, "not a date", now)).toBe(false)
  })

  test("writeCache creates the directory and readCache round-trips", () => {
    expect(readCache(config)).toBeNull()
    writeCache(config, { data: [] }, "https://x", "live")
    expect(existsSync(cacheFile(config))).toBe(true)
    const cached = readCache(config)!
    expect(cached.payload).toEqual({ data: [] })
    expect(Number.isFinite(Date.parse(cached.fetchedAt))).toBe(true)
  })

  test("a corrupt cache file reads as no cache", () => {
    writeCache(config, {}, "u", "live")
    writeFileSync(cacheFile(config), "{not json")
    expect(readCache(config)).toBeNull()
  })

  test("the API key is never written to the cache", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    await loadAADataset(config, { env: { ARTIFICIAL_ANALYSIS_API_KEY: "sekrit-key-123" }, fetchFn })
    expect(readFileSync(cacheFile(config), "utf8")).not.toContain("sekrit-key-123")
  })
})

describe("loadAADataset", () => {
  const payload = { data: [aaRow("Alpha (max)", "alpha", { coding: 90, intelligence: 80, costPerTask: 2 })] }
  const env = { ARTIFICIAL_ANALYSIS_API_KEY: "test-key" }

  function fakeFetch(handlers: Record<string, () => Response>, calls: string[] = []) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push(u)
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key")
      for (const [suffix, handler] of Object.entries(handlers)) {
        if (u.endsWith(suffix)) return handler()
      }
      throw new Error(`unexpected url ${u}`)
    }) as unknown as typeof fetch
  }

  const ok = () => new Response(JSON.stringify(payload), { status: 200 })

  test("a missing key fails with an actionable error that never mentions a value", async () => {
    await expect(loadAADataset(config, { env: {} })).rejects.toThrow(/ARTIFICIAL_ANALYSIS_API_KEY is not set/)
    await expect(loadAADataset(config, { env: {} })).rejects.toThrow(/--offline/)
  })

  test("the live endpoint is used when the key is allowed", async () => {
    const calls: string[] = []
    const result = await loadAADataset(config, { env, fetchFn: fakeFetch({ "/language/models": ok }, calls) })
    expect(result.kind).toBe("live")
    expect(result.warnings).toEqual([])
    expect(result.models).toHaveLength(1)
    expect(calls).toEqual([`${config.api.baseUrl}/language/models`])
  })

  test("403 falls back to /free with a warning naming the fields that are lost", async () => {
    const calls: string[] = []
    const result = await loadAADataset(config, {
      env,
      fetchFn: fakeFetch(
        {
          "/language/models/free": ok,
          "/language/models": () => new Response("no", { status: 403 }),
        },
        calls,
      ),
    })
    expect(result.kind).toBe("free")
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEndWith("/language/models/free")
    const warning = result.warnings.join(" ")
    expect(warning).toContain("403")
    expect(warning).toContain("/language/models/free")
    expect(warning).toContain("context_window_tokens")
    expect(warning).toContain("end-to-end response time")
    expect(warning).toContain("blended 3:1 pricing")
    expect(warning).not.toContain("test-key")
  })

  test("401 takes the same fallback path", async () => {
    const result = await loadAADataset(config, {
      env,
      fetchFn: fakeFetch({
        "/language/models/free": ok,
        "/language/models": () => new Response("no", { status: 401 }),
      }),
    })
    expect(result.kind).toBe("free")
  })

  test("a fresh cache is used without any network call", async () => {
    writeCache(config, payload, "u", "live")
    const calls: string[] = []
    const result = await loadAADataset(config, { env: {}, fetchFn: fakeFetch({}, calls) })
    expect(result.kind).toBe("cache")
    expect(calls).toEqual([])
    expect(result.models).toHaveLength(1)
  })

  test("--refresh ignores a fresh cache", async () => {
    writeCache(config, { data: [] }, "u", "live")
    const result = await loadAADataset(config, {
      env,
      refresh: true,
      fetchFn: fakeFetch({ "/language/models": ok }),
    })
    expect(result.kind).toBe("live")
    expect(result.models).toHaveLength(1)
  })

  test("an expired cache triggers a refetch", async () => {
    writeCache(config, { data: [] }, "u", "live")
    const later = new Date(Date.now() + 13 * 3_600_000)
    const result = await loadAADataset(config, { env, now: later, fetchFn: fakeFetch({ "/language/models": ok }) })
    expect(result.kind).toBe("live")
  })

  test("a network failure falls back to the stale cache with a visible warning", async () => {
    writeCache(config, payload, "u", "live")
    const later = new Date(Date.now() + 13 * 3_600_000)
    const result = await loadAADataset(config, {
      env,
      now: later,
      fetchFn: (async () => {
        throw new Error("ECONNRESET")
      }) as unknown as typeof fetch,
    })
    expect(result.kind).toBe("cache")
    expect(result.warnings.join(" ")).toContain("ECONNRESET")
    expect(result.warnings.join(" ")).toContain("cached response")
    expect(result.models).toHaveLength(1)
  })

  test("a network failure with no cache is an error, not an empty result", async () => {
    await expect(
      loadAADataset(config, {
        env,
        fetchFn: (async () => {
          throw new Error("ECONNRESET")
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("ECONNRESET")
  })

  test("a 500 with no cache surfaces the status", async () => {
    await expect(
      loadAADataset(config, { env, fetchFn: fakeFetch({ "/language/models": () => new Response("x", { status: 500 }) }) }),
    ).rejects.toThrow(/AA 500/)
  })

  test("--offline reads the file, writes no cache and needs no key", async () => {
    const file = join(dir, "snap.json")
    writeFileSync(file, JSON.stringify({ ...payload, fetchedAt: "2026-08-01T00:00:00Z" }))
    const result = await loadAADataset(config, { env: {}, offline: file })
    expect(result.kind).toBe("offline")
    expect(result.timestamp).toBe("2026-08-01T00:00:00Z")
    expect(existsSync(cacheFile(config))).toBe(false)
  })
})

function entry(overrides: Partial<ChainEntry> = {}): ChainEntry {
  return {
    piId: "openai-codex/gpt-6-sol:high",
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    thinking: "high",
    aaSlug: "gpt-6-sol",
    aaName: "GPT-6 Sol (high)",
    capability: 60,
    cost: 4,
    costBasis: "per-task",
    effectiveCost: 1,
    billing: "subscription",
    speedSeconds: 12,
    speedBasis: "end-to-end",
    requestsPer5h: null,
    reason: "#1",
    ...overrides,
  }
}

const chain = (tier: string, entries: ChainEntry[]): TierChain => ({
  tier,
  rule: "capability",
  floor: "capability >= 97% of best",
  entries,
  poolSize: entries.length,
  diversity: "ok",
  reserved: [],
})

describe("formatPinball", () => {
  test("emits provider/id pairs, with thinking only where the entry has it", () => {
    const out = formatPinball(
      chain("dev", [entry(), entry({ piId: "google/gemini-3.8-flash", provider: "google", modelId: "gemini-3.8-flash", thinking: null })]),
    )
    expect(out).toEqual([
      { provider: "openai-codex", id: "gpt-6-sol", thinking: "high" },
      { provider: "google", id: "gemini-3.8-flash" },
    ])
  })

  test("keeps a vendor-prefixed id whole", () => {
    const out = formatPinball(chain("x", [entry({ provider: "huggingface", modelId: "deepseek-ai/DeepSeek-R1", thinking: null })]))
    expect(out[0]).toEqual({ provider: "huggingface", id: "deepseek-ai/DeepSeek-R1" })
  })

  test("an empty chain is an empty array", () => {
    expect(formatPinball(chain("x", []))).toEqual([])
  })
})

describe("renderDefaultsYaml", () => {
  const meta = {
    generatedAt: "2026-09-29T00:00:00.000Z",
    dataTimestamp: "2026-09-29T00:00:00.000Z",
    dataKind: "live",
    command: "bun tools/model-tiers/model-tiers.ts --write-defaults",
  }
  const yaml = renderDefaultsYaml(
    [chain("cto", [entry()]), chain("dev", [entry({ piId: "google/gemini-3.8-flash" }), entry({ piId: "opencode-go/kimi-k3:medium" })]), chain("intern", [])],
    meta,
  )

  test("header states it is generated, when, from which AA data, and how to regenerate", () => {
    const head = yaml.split("\n").filter((l) => l.startsWith("#")).join("\n")
    expect(head).toContain("GENERATED FILE — DO NOT EDIT BY HAND")
    expect(head).toContain("Generated at: 2026-09-29T00:00:00.000Z")
    expect(head).toContain("Artificial Analysis data: 2026-09-29T00:00:00.000Z (live)")
    expect(head).toContain("Regenerate with: bun tools/model-tiers/model-tiers.ts --write-defaults")
  })

  test("one ordered list per tier in harness:model style", () => {
    expect(yaml).toContain("cto:\n  - pi:openai-codex/gpt-6-sol:high\n")
    expect(yaml).toContain("dev:\n  - pi:google/gemini-3.8-flash\n  - pi:opencode-go/kimi-k3:medium\n")
  })

  test("an empty tier renders as an explicit empty list, keeping the YAML valid", () => {
    expect(yaml).toContain("intern:\n  []\n")
  })

  test("ends with exactly one newline and a missing AA timestamp is stated", () => {
    expect(yaml.endsWith("\n")).toBe(true)
    expect(yaml.endsWith("\n\n")).toBe(false)
    expect(renderDefaultsYaml([], { ...meta, dataTimestamp: null })).toContain("unknown (no timestamp in source)")
  })

  test("the generated document parses as YAML", () => {
    const parsed = Bun.YAML.parse(yaml) as Record<string, string[]>
    expect(parsed.cto).toEqual(["pi:openai-codex/gpt-6-sol:high"])
    expect(parsed.dev).toHaveLength(2)
    expect(parsed.intern).toEqual([])
  })
})

describe("formatTable", () => {
  test("prints warnings, every tier, and the unmapped list", () => {
    const text = formatTable([chain("cto", [entry()]), chain("intern", [])], {
      dataKind: "free",
      dataTimestamp: null,
      models: 1,
      piModels: 1,
      candidates: 1,
      unmapped: 2,
      unmappedModels: ["A", "B"],
      blockedModels: ["groq/x"],
      warnings: ["fell back to free"],
    })
    expect(text).toContain("! fell back to free")
    expect(text).toContain("x blocked by config: groq/x")
    expect(text).toContain("CTO")
    expect(text).toContain("(no candidates)")
    expect(text).toContain("unmapped AA models (2): A, B")
  })
})

describe("parseArgs", () => {
  test("defaults", () => {
    const args = parseArgs([])
    expect(args.json).toBe(false)
    expect(args.refresh).toBe(false)
    expect(args.writeDefaults).toBeUndefined()
    expect(args.offline).toBeUndefined()
  })

  test("value flags take the next argument", () => {
    const args = parseArgs(["--offline", "agent/llms.json", "--pinball", "dev", "--pi-list", "pi.txt", "--json", "--refresh"])
    expect(args).toMatchObject({ offline: "agent/llms.json", pinball: "dev", piList: "pi.txt", json: true, refresh: true })
  })

  test("--write-defaults with and without a path", () => {
    expect(parseArgs(["--write-defaults"]).writeDefaults).toBeNull()
    expect(parseArgs(["--write-defaults", "out.yaml"]).writeDefaults).toBe("out.yaml")
    expect(parseArgs(["--write-defaults", "--json"]).writeDefaults).toBeNull()
    expect(parseArgs(["--write-defaults", "--json"]).json).toBe(true)
  })

  test("--help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  test("an unknown flag is an error", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument: --bogus")
  })
})
