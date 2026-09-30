import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  cacheIsFresh,
  checkAgainstPi,
  checkCoverage,
  checkOrder,
  dataNotes,
  exitCode,
  formatGaps,
  formatProposals,
  loadAA,
  matchRow,
  normalizeName,
  normalizeRows,
  parseArgs,
  parseEffort,
  parseEntry,
  parsePiModels,
  parseSkips,
  parseTable,
  parseTokenCount,
  type PiModel,
  type TableEntry,
} from "./check.ts"

/** A raw AA row shaped like the free/live payload. */
function aaRow(
  name: string,
  slug: string,
  opts: { intelligence?: number; costPerTask?: number; endToEnd?: number } = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    name,
    slug,
    evaluations: { artificial_analysis_intelligence_index: opts.intelligence ?? null, artificial_analysis_coding_index: null },
    performance: { median_end_to_end_response_time_seconds: opts.endToEnd ?? null },
  }
  if (opts.costPerTask != null) row.artificial_analysis_intelligence_index_cost = { cost_per_task: { total_cost: opts.costPerTask } }
  return row
}

const pi = (provider: string, id: string, thinking = true): PiModel => ({ provider, id, contextTokens: 200_000, thinking })
const entry = (raw: string, role = "developer"): TableEntry => parseEntry(role, raw)
const rowsOf = (...rows: Record<string, unknown>[]) => normalizeRows(rows)
const intel = (name: string, slug: string, n: number) => aaRow(name, slug, { intelligence: n })

describe("table entries", () => {
  test("claude entries: model with an optional @effort", () => {
    expect(entry("claude:opus@xhigh")).toMatchObject({ harness: "claude", model: "opus", effort: "xhigh", provider: null })
    expect(entry("claude:sonnet")).toMatchObject({ model: "sonnet", effort: null })
  })

  test("pi entries: provider/model with an optional :thinking", () => {
    expect(entry("pi:openai-codex/gpt-6-astra:xhigh")).toMatchObject({ provider: "openai-codex", model: "gpt-6-astra", effort: "xhigh" })
    expect(entry("pi:opencode-go/space-bunny-free")).toMatchObject({ provider: "opencode-go", model: "space-bunny-free", effort: null })
  })

  test("a model id with its own slash keeps everything after the provider", () => {
    expect(entry("pi:huggingface/moonshotai/Kimi-K2-Thinking:high")).toMatchObject({
      provider: "huggingface",
      model: "moonshotai/Kimi-K2-Thinking",
      effort: "high",
    })
  })

  test("a colon suffix that is not a thinking level stays in the model id", () => {
    expect(entry("pi:p/m:latest")).toMatchObject({ model: "m:latest", effort: null })
  })

  test.each(["opus", "claude:", "pi:nomodel", "pi:/m", "pi:p/"])("%s is rejected", (bad) => {
    expect(() => parseEntry("r", bad)).toThrow()
  })
})

describe("table file", () => {
  test("reads routing: role -> entries and ignores comments", () => {
    const entries = parseTable("routing:\n  reviewer:\n    - claude:opus@high # why\n    - pi:p/m:low\n  mechanic:\n    - pi:p/n\n")
    expect(entries.map((e) => `${e.role}=${e.raw}`)).toEqual(["reviewer=claude:opus@high", "reviewer=pi:p/m:low", "mechanic=pi:p/n"])
  })

  test.each([
    ["no routing key", "reviewer:\n  - pi:p/m\n"],
    ["empty role", "routing:\n  reviewer: []\n"],
    ["non-string entry", "routing:\n  reviewer:\n    - {a: b}\n"],
    ["empty document", ""],
  ])("%s is an error", (_name, text) => {
    expect(() => parseTable(text)).toThrow()
  })

  test("skip: is optional, and must be a list of strings", () => {
    expect(parseSkips("routing:\n  r:\n    - pi:p/m\n")).toEqual([])
    expect(parseSkips("skip:\n  - pi:p/x # note\n")).toEqual(["pi:p/x"])
    expect(() => parseSkips("skip: nope\n")).toThrow()
  })
})

describe("pi models", () => {
  test("token counts", () => {
    expect(parseTokenCount("272K")).toBe(272_000)
    expect(parseTokenCount("1.1M")).toBe(1_100_000)
    expect(parseTokenCount("131072")).toBe(131_072)
    expect(parseTokenCount("-")).toBeNull()
    expect(parseTokenCount(undefined)).toBeNull()
  })

  test("parses the list, skipping the header and malformed lines", () => {
    const models = parsePiModels(
      "provider      model         context  max-out  thinking  images\n" +
        "openai-codex  gpt-6-sol     272K     128K     yes       no\n" +
        "huggingface   a/b-c         262.1K   262.1K   no        yes\n" +
        "garbage line\n",
    )
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ provider: "openai-codex", id: "gpt-6-sol", thinking: true, contextTokens: 272_000 })
    expect(models[1]).toMatchObject({ id: "a/b-c", thinking: false })
  })
})

describe("AA rows", () => {
  test("effort comes from the parenthetical, including descriptive ones", () => {
    expect(parseEffort("GPT-6 Sol (high)")).toBe("high")
    expect(parseEffort("Claude Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)")).toBe("max")
    expect(parseEffort("X (Non-reasoning)")).toBe("off")
    expect(parseEffort("Kimi K3")).toBeNull()
  })

  test("normalizeName drops parentheticals and punctuation", () => {
    expect(normalizeName("GPT-6 Sol (high)")).toBe("gpt6sol")
  })

  test("reads the free envelope, the bare array and drops rows without a name", () => {
    const row = aaRow("GPT-6 Sol (low)", "sol-low", { intelligence: 33.9, costPerTask: 0.13, endToEnd: 9.46 })
    for (const payload of [{ data: [row] }, [row], { data: [row, { slug: "x" }] }]) {
      const [only] = normalizeRows(payload)
      expect(only).toMatchObject({ baseKey: "gpt6sol", effort: "low", intelligence: 33.9, cost: 0.13, speedSeconds: 9.46 })
    }
    expect(normalizeRows({ nothing: 1 })).toEqual([])
  })
})

describe("matching a table entry to its AA row", () => {
  const rows = rowsOf(
    intel("GPT-6 Sol (low)", "sol-low", 33.9),
    intel("GPT-6.1 Sol (high)", "sol61-high", 50.2),
    intel("GPT-6.1 Sol (xhigh)", "sol61-xhigh", 51),
    intel("MiMo-V2.6-Pro", "mimo", 46.3),
    intel("Claude Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)", "opus-max", 60),
  )

  test("the row at the entry's own effort is measured", () => {
    expect(matchRow(entry("pi:openai-codex/gpt-6.1-sol:xhigh"), rows)).toMatchObject({ status: "measured" })
    expect(matchRow(entry("pi:openai-codex/gpt-6.1-sol:xhigh"), rows).row?.intelligence).toBe(51)
  })

  test("no row at that effort is missing, never another effort's row (Sol low is not Sol medium)", () => {
    const m = matchRow(entry("pi:openai-codex/gpt-6-sol:medium"), rows)
    expect(m.status).toBe("missing")
    expect(m.row).toBeNull()
    expect(m.available).toEqual(["low"])
  })

  test("a model AA lists with no effort marker is measured at any effort", () => {
    expect(matchRow(entry("pi:opencode-go/mimo-v2.6-pro:medium"), rows).status).toBe("measured")
    expect(matchRow(entry("pi:opencode-go/mimo-v2.6-pro"), rows).status).toBe("measured")
  })

  test("an entry with no effort does not match a row that names one", () => {
    expect(matchRow(entry("claude:opus"), rows).status).toBe("missing")
    expect(matchRow(entry("claude:opus@high"), rows).status).toBe("missing")
    expect(matchRow(entry("claude:opus@max"), rows).status).toBe("measured")
  })

  test("a model AA lacks is no-aa", () => {
    expect(matchRow(entry("pi:opencode-go/space-bunny-free"), rows)).toMatchObject({ status: "no-aa", available: [] })
  })
})

describe("check: pi no longer lists an entry", () => {
  const models = [pi("openai-codex", "gpt-6-astra"), pi("opencode-go", "mimo-v2.6-flash", false)]

  test("an entry pi lacks is a remove proposal naming the role", () => {
    const out = checkAgainstPi([entry("pi:openai-codex/gpt-9:high", "reviewer")], models)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "remove", role: "reviewer" })
    expect(out[0].text).toContain("openai-codex/gpt-9")
  })

  test("claude entries are not checked against pi", () => {
    expect(checkAgainstPi([entry("claude:opus@high")], models)).toEqual([])
  })

  test("a thinking level on a model without thinking is a note", () => {
    const out = checkAgainstPi([entry("pi:opencode-go/mimo-v2.6-flash:low")], models)
    expect(out.map((p) => p.kind)).toEqual(["note"])
  })

  test("everything present is quiet", () => {
    expect(checkAgainstPi([entry("pi:openai-codex/gpt-6-astra:high")], models)).toEqual([])
  })
})

describe("check: pi models no role uses", () => {
  const models = [pi("openai-codex", "a"), pi("openai-codex", "b"), pi("kimi-coding", "c"), pi("groq", "d")]

  test("lists covered-provider models missing from the table, not other providers", () => {
    const out = checkCoverage([entry("pi:openai-codex/a")], models, ["openai-codex", "kimi-coding"])
    expect(out.map((p) => p.text.split(":")[0] + ":" + p.text.split(":")[1])).toEqual(["pi:openai-codex/b", "pi:kimi-coding/c"])
    expect(out.every((p) => p.kind === "add" && p.role === null)).toBe(true)
  })

  test("skip: silences a model the table leaves out on purpose", () => {
    const out = checkCoverage([entry("pi:openai-codex/a")], models, ["openai-codex", "kimi-coding"], ["pi:openai-codex/b", "pi:kimi-coding/c"])
    expect(out).toEqual([])
  })

  test("a model used with any thinking level counts as used", () => {
    expect(checkCoverage([entry("pi:openai-codex/a:high"), entry("pi:openai-codex/b:low")], [models[0], models[1]], ["openai-codex"])).toEqual([])
  })
})

describe("check: order against same-effort AA rows", () => {
  const rows = rowsOf(
    intel("Aa (high)", "aa", 40),
    intel("Bb (high)", "bb", 47),
    intel("Cc (low)", "cc", 60),
    intel("Dd (high)", "dd", 41),
  )
  const chain = (...raws: string[]) => raws.map((r) => entry(r, "dev"))

  test("a later entry clearly above an earlier one at the same effort is a reorder", () => {
    const out = checkOrder(chain("pi:p/aa:high", "pi:p/bb:high"), rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "reorder", role: "dev" })
    expect(out[0].text).toContain("7.0 points")
  })

  test("a gap under the margin is left alone", () => {
    expect(checkOrder(chain("pi:p/aa:high", "pi:p/dd:high"), rows)).toEqual([])
  })

  test("the right order is quiet", () => {
    expect(checkOrder(chain("pi:p/bb:high", "pi:p/aa:high"), rows)).toEqual([])
  })

  test("entries at different efforts are never compared", () => {
    expect(checkOrder(chain("pi:p/aa:high", "pi:p/cc:low"), rows)).toEqual([])
  })

  test("an entry with no measured row at its effort is skipped, not guessed", () => {
    expect(checkOrder(chain("pi:p/aa:high", "pi:p/cc:high"), rows)).toEqual([])
  })

  test("roles do not compare across each other", () => {
    const two = [entry("pi:p/aa:high", "x"), entry("pi:p/bb:high", "y")]
    expect(checkOrder(two, rows)).toEqual([])
  })

  test("the margin is an argument", () => {
    expect(checkOrder(chain("pi:p/aa:high", "pi:p/dd:high"), rows, 1)).toHaveLength(1)
  })
})

describe("proposals output", () => {
  test("remove and add exit 1; reorder and notes exit 0; none is quiet", () => {
    expect(exitCode([{ kind: "remove", role: "r", text: "x" }])).toBe(1)
    expect(exitCode([{ kind: "add", role: null, text: "x" }])).toBe(1)
    expect(exitCode([{ kind: "reorder", role: "r", text: "x" }, { kind: "note", role: null, text: "y" }])).toBe(0)
    expect(exitCode([])).toBe(0)
    expect(formatProposals([])).toBe("no diffs proposed")
  })

  test("one line per proposal, signed by kind", () => {
    const text = formatProposals([
      { kind: "remove", role: "r", text: "gone" },
      { kind: "add", role: null, text: "new" },
    ])
    expect(text.split("\n")).toEqual(["- remove [r]: gone", "+ add: new"])
  })

  test("data notes: absent AA data is loud, age is reported", () => {
    const missing = dataNotes(null, "no key")
    expect(missing[0].text).toContain("AA data unavailable (no key)")
    const now = Date.parse("2026-09-30T12:00:00Z")
    const aged = dataNotes({ rows: [], fetchedAt: "2026-09-30T02:00:00Z", kind: "cache", notes: ["free endpoint"] }, null, now)
    expect(aged.map((p) => p.text)).toEqual(["free endpoint", "AA data (cache) is 10 h old"])
  })

  test("the gaps table has one row per entry with status and the efforts AA has", () => {
    const rows = rowsOf(intel("GPT-6 Sol (low)", "sol-low", 33.9))
    const text = formatGaps([entry("pi:openai-codex/gpt-6-sol:low"), entry("pi:openai-codex/gpt-6-sol:high"), entry("pi:o/zzz")], rows)
    const lines = text.split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain("measured")
    expect(lines[2]).toContain("missing at this effort")
    expect(lines[3]).toContain("not in AA")
  })
})

describe("loading AA data", () => {
  const payload = { data: [aaRow("GPT-6 Sol (low)", "sol-low", { intelligence: 33.9 })] }
  const dir = () => mkdtempSync(join(tmpdir(), "check-test-"))
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  test("a fresh cache is used without a key or a network call", async () => {
    const cacheFile = join(dir(), "aa.json")
    const now = Date.parse("2026-09-30T12:00:00Z")
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: "2026-09-30T10:00:00Z", payload }))
    const fetchFn = (() => { throw new Error("no network expected") }) as unknown as typeof fetch
    const data = await loadAA({ cacheFile, env: {}, fetchFn, now })
    expect(data.kind).toBe("cache")
    expect(data.rows).toHaveLength(1)
  })

  test("a stale cache with no key is an error naming the key", async () => {
    const cacheFile = join(dir(), "aa.json")
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: "2020-01-01T00:00:00Z", payload }))
    await expect(loadAA({ cacheFile, env: {} })).rejects.toThrow("ARTIFICIAL_ANALYSIS_API_KEY")
  })

  test("a 403 on the full endpoint falls back to /free, says what is lost, and writes the cache", async () => {
    const cacheFile = join(dir(), "aa.json")
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(String(url))
      return String(url).endsWith("/free") ? json(payload) : json({}, 403)
    }) as unknown as typeof fetch
    const data = await loadAA({ cacheFile, env: { ARTIFICIAL_ANALYSIS_API_KEY: "k" }, fetchFn, now: Date.parse("2026-09-30T12:00:00Z") })
    expect(seen).toHaveLength(2)
    expect(data.kind).toBe("free")
    expect(data.notes[0]).toContain("Pro+ key")
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).kind).toBe("free")
  })

  test("a failed fetch falls back to a stale cache and says so", async () => {
    const cacheFile = join(dir(), "aa.json")
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: "2020-01-01T00:00:00Z", payload }))
    const fetchFn = (async () => json({}, 500)) as unknown as typeof fetch
    const data = await loadAA({ cacheFile, env: { ARTIFICIAL_ANALYSIS_API_KEY: "k" }, fetchFn })
    expect(data.kind).toBe("cache")
    expect(data.notes[0]).toContain("AA fetch failed")
  })

  test("a failed fetch with no cache throws", async () => {
    const fetchFn = (async () => json({}, 500)) as unknown as typeof fetch
    await expect(loadAA({ cacheFile: join(dir(), "none.json"), env: { ARTIFICIAL_ANALYSIS_API_KEY: "k" }, fetchFn })).rejects.toThrow("AA 500")
  })

  test("--offline reads a snapshot and never touches the cache", async () => {
    const file = join(dir(), "snap.json")
    writeFileSync(file, JSON.stringify(payload))
    const data = await loadAA({ offline: file, env: {} })
    expect(data.kind).toBe("offline")
    expect(data.rows).toHaveLength(1)
  })

  test("cache freshness is bounded by the TTL", () => {
    const now = Date.parse("2026-09-30T12:00:00Z")
    expect(cacheIsFresh("2026-09-30T11:00:00Z", now)).toBe(true)
    expect(cacheIsFresh("2026-09-29T11:00:00Z", now)).toBe(false)
    expect(cacheIsFresh("not a date", now)).toBe(false)
  })
})

describe("CLI arguments", () => {
  test("defaults", () => {
    const args = parseArgs([])
    expect(args).toMatchObject({ refresh: false, gaps: false, help: false, providers: ["openai-codex", "kimi-coding"] })
    expect(args.table).toEndWith("src/plugins/team-lead/skills/team-lead/default-models.yaml")
  })

  test("flags", () => {
    const args = parseArgs(["--gaps", "--refresh", "--offline", "a.json", "--pi-list", "p.txt", "--providers", "x, y", "--table", "t.yaml"])
    expect(args).toMatchObject({ gaps: true, refresh: true, offline: "a.json", piList: "p.txt", providers: ["x", "y"] })
    expect(args.table).toBe(resolve("t.yaml"))
  })

  test("unknown flag and a flag without its value are errors", () => {
    expect(() => parseArgs(["--write"])).toThrow("unknown argument")
    expect(() => parseArgs(["--table"])).toThrow("needs a value")
  })
})

describe("the shipped table", () => {
  const text = readFileSync(resolve(import.meta.dir, "../../src/plugins/team-lead/skills/team-lead/default-models.yaml"), "utf8")
  const entries = parseTable(text)
  const chain = (role: string) => entries.filter((e) => e.role === role).map((e) => e.raw)

  test("has exactly the skill's six roles", () => {
    expect([...new Set(entries.map((e) => e.role))].sort()).toEqual(
      ["developer", "mechanic", "researcher", "reviewer", "senior-dev", "squad-leader"],
    )
  })

  test("gpt-6.1-sol sits directly after gpt-6-astra wherever Astra appears (operator decision)", () => {
    let seen = 0
    for (const role of new Set(entries.map((e) => e.role))) {
      const c = chain(role)
      const at = c.findIndex((r) => r.startsWith("pi:openai-codex/gpt-6-astra"))
      if (at === -1) continue
      seen++
      expect(c[at + 1]).toMatch(/^pi:openai-codex\/gpt-6\.1-sol/)
    }
    expect(seen).toBe(3)
  })

  test("claude:sonnet is third in developer (operator decision)", () => {
    expect(chain("developer")[2]).toBe("claude:sonnet")
  })

  test("no role lists a model twice, and the reviewer family is disjoint from the dev family", () => {
    for (const role of new Set(entries.map((e) => e.role))) {
      const models = entries.filter((e) => e.role === role).map((e) => `${e.harness}:${e.provider ?? ""}/${e.model}`)
      expect(new Set(models).size).toBe(models.length)
    }
    expect(chain("reviewer").some((r) => /kimi|mimo/.test(r))).toBe(false)
  })

  test("free models are never a chain's primary, and Space Bunny stays out of dev loops", () => {
    for (const role of new Set(entries.map((e) => e.role))) expect(chain(role)[0]).not.toMatch(/free/)
    expect(chain("developer").join(" ")).not.toContain("space-bunny")
    expect(chain("mechanic").join(" ")).not.toContain("free")
  })

  test("says it is curated", () => {
    expect(text.split("\n")[0]).toContain("CURATED")
  })
})
