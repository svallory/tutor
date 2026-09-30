#!/usr/bin/env bun
/**
 * check — compare the curated team-lead model table against live data and PROPOSE diffs.
 * It never writes the table: the operator edits default-models.yaml by hand.
 *
 *   bun --env-file ~/work/.env tools/model-tiers/check.ts [options]
 *
 *   --table <file>       curated table (default: src/plugins/team-lead/skills/team-lead/default-models.yaml)
 *   --offline <file>     read Artificial Analysis (AA) data from a local snapshot instead of the API
 *   --refresh            ignore the AA response cache and refetch
 *   --pi-list <file>     use a saved `pi --list-models` dump instead of running pi
 *   --providers <a,b>    providers whose pi models the table is expected to cover
 *                        (default: openai-codex,kimi-coding)
 *   --gaps               also print, per table entry, whether AA has a row at the entry's own effort
 *   --help               this header
 *
 * Exit codes: 0 no remove/add proposals; 1 at least one remove or add proposal; 2 argument or I/O error
 * (unknown flag, missing table or pi list, unreadable or malformed table, `pi --list-models` failing).
 *
 * Checks (exit 1 on the first two):
 *   remove    table entries pi no longer lists
 *   add       pi models of the covered providers that no role uses and the table's `skip:` list omits
 *   reorder   entries in one role at the SAME effort where AA's Intelligence index puts a later entry
 *             clearly above an earlier one (measured rows only; a row at another effort is never used)
 *   note      pi has no thinking levels for an entry that names one; AA data age or absence
 *
 * No scoring, floors, placement or ranking config: the table is the decision, AA is only evidence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

export type Effort = "max" | "xhigh" | "high" | "medium" | "low" | "off"

export interface PiModel {
  provider: string
  id: string
  contextTokens: number | null
  thinking: boolean
}

export interface AARow {
  slug: string
  name: string
  baseKey: string
  effort: Effort | null
  intelligence: number | null
  coding: number | null
  cost: number | null
  speedSeconds: number | null
}

export interface TableEntry {
  role: string
  raw: string
  harness: string
  /** pi only */
  provider: string | null
  model: string
  /** claude `@effort` or pi `:thinking` */
  effort: string | null
}

export type RowStatus = "measured" | "missing" | "no-aa"

export interface RowMatch {
  status: RowStatus
  row: AARow | null
  /** efforts AA has rows for on this model ("unmarked" = no effort marker) */
  available: string[]
}

export interface Proposal {
  kind: "remove" | "add" | "reorder" | "note"
  role: string | null
  text: string
}

// ---------------------------------------------------------------------------------------------
// the curated table
// ---------------------------------------------------------------------------------------------

const EFFORTS = ["max", "xhigh", "high", "medium", "low", "off", "minimal"]

export function parseEntry(role: string, raw: string): TableEntry {
  const text = raw.trim()
  const colon = text.indexOf(":")
  if (colon <= 0) throw new Error(`${role}: "${raw}" is not harness:model`)
  const harness = text.slice(0, colon)
  const rest = text.slice(colon + 1)
  if (!rest) throw new Error(`${role}: "${raw}" has no model`)
  if (harness === "pi") {
    const slash = rest.indexOf("/")
    if (slash <= 0 || slash === rest.length - 1) throw new Error(`${role}: "${raw}" is not pi:<provider>/<model>`)
    const provider = rest.slice(0, slash)
    let model = rest.slice(slash + 1)
    let effort: string | null = null
    const last = model.lastIndexOf(":")
    if (last > 0 && EFFORTS.includes(model.slice(last + 1))) {
      effort = model.slice(last + 1)
      model = model.slice(0, last)
    }
    return { role, raw, harness, provider, model, effort }
  }
  const [model, effort] = rest.split("@")
  return { role, raw, harness, provider: null, model, effort: effort ?? null }
}

/** Parse the curated YAML: a top-level `routing:` map of role -> list of harness:model strings. */
export function parseTable(text: string): TableEntry[] {
  const doc = Bun.YAML.parse(text) as { routing?: Record<string, unknown> } | null
  const routing = doc?.routing
  if (!routing || typeof routing !== "object") throw new Error("table has no `routing:` map")
  const entries: TableEntry[] = []
  for (const [role, list] of Object.entries(routing)) {
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${role}: expected a non-empty list`)
    for (const item of list) {
      if (typeof item !== "string") throw new Error(`${role}: entries are harness:model strings`)
      entries.push(parseEntry(role, item))
    }
  }
  return entries
}

/** `skip:` entries: models left out of every role on purpose, so the coverage check stays quiet. */
export function parseSkips(text: string): string[] {
  const skip = (Bun.YAML.parse(text) as { skip?: unknown } | null)?.skip
  if (skip == null) return []
  if (!Array.isArray(skip) || skip.some((s) => typeof s !== "string")) throw new Error("`skip:` must be a list of pi:<provider>/<model> strings")
  return skip as string[]
}

// ---------------------------------------------------------------------------------------------
// pi models
// ---------------------------------------------------------------------------------------------

export function parseTokenCount(raw: string | undefined): number | null {
  if (!raw) return null
  const m = /^([\d.]+)([KkMm])?$/.exec(raw.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  const unit = (m[2] ?? "").toLowerCase()
  return Math.round(unit === "k" ? value * 1_000 : unit === "m" ? value * 1_000_000 : value)
}

/** Parse `pi --list-models` output: provider, model, context, max-out, thinking, images. */
export function parsePiModels(text: string): PiModel[] {
  const models: PiModel[] = []
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const images = parts[parts.length - 1]
    const thinking = parts[parts.length - 2]
    if (!["yes", "no"].includes(thinking) || !["yes", "no"].includes(images)) continue
    const id = parts.slice(1, parts.length - 4).join(" ")
    if (!parts[0] || !id) continue
    models.push({
      provider: parts[0],
      id,
      contextTokens: parseTokenCount(parts[parts.length - 4]),
      thinking: thinking === "yes",
    })
  }
  return models
}

export function loadPiModels(listFile?: string): PiModel[] {
  if (listFile) return parsePiModels(readFileSync(listFile, "utf8"))
  const proc = Bun.spawnSync(["pi", "--list-models"], { stdout: "pipe", stderr: "pipe" })
  if (!proc.success) throw new Error("`pi --list-models` failed; run it in a configured pi or pass --pi-list <file>")
  const models = parsePiModels(proc.stdout.toString())
  if (models.length === 0) throw new Error("`pi --list-models` returned no models")
  return models
}

// ---------------------------------------------------------------------------------------------
// Artificial Analysis
// ---------------------------------------------------------------------------------------------

const EFFORT_WORDS: Record<string, Effort> = {
  max: "max",
  xhigh: "xhigh",
  high: "high",
  medium: "medium",
  low: "low",
  minimal: "low",
  off: "off",
  "non-reasoning": "off",
}

/** lowercase, drop every parenthetical, drop everything but a-z0-9. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, "")
}

/** Effort marker from a name parenthetical, e.g. "GPT-6 Sol (high)" -> "high". */
export function parseEffort(name: string): Effort | null {
  for (const match of name.matchAll(/\(([^)]*)\)/g)) {
    const text = match[1].trim().toLowerCase()
    if (EFFORT_WORDS[text]) return EFFORT_WORDS[text]
    if (/\bnon[- ]?reasoning\b/.test(text)) return "off"
    const effort = /\b(max|xhigh|high|medium|low|minimal)\s+effort\b/.exec(text)
    if (effort) return EFFORT_WORDS[effort[1]]
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function dig(root: unknown, ...path: string[]): unknown {
  let node = root
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Accepts the live envelope, the free envelope, agent/llms.json, or a bare array. */
export function normalizeRows(payload: unknown): AARow[] {
  const raw: unknown[] = Array.isArray(payload) ? payload : Array.isArray(dig(payload, "data")) ? (dig(payload, "data") as unknown[]) : []
  const rows: AARow[] = []
  for (const item of raw) {
    const name = dig(item, "name")
    const slug = dig(item, "slug")
    if (typeof name !== "string" || typeof slug !== "string") continue
    const perTask = num(dig(item, "artificial_analysis_intelligence_index_cost", "cost_per_task", "total_cost"))
    const e2e = num(dig(item, "performance", "median_end_to_end_response_time_seconds"))
    rows.push({
      slug,
      name,
      baseKey: normalizeName(name) || normalizeName(slug),
      effort: parseEffort(name),
      intelligence: num(dig(item, "evaluations", "artificial_analysis_intelligence_index")),
      coding: num(dig(item, "evaluations", "artificial_analysis_coding_index")),
      cost: perTask,
      speedSeconds: e2e != null && e2e > 0 ? e2e : null,
    })
  }
  return rows
}

const AA = {
  baseUrl: "https://artificialanalysis.ai/api/v2",
  fullPath: "/language/models",
  freePath: "/language/models/free",
  cacheFile: join(homedir(), ".cache", "model-tiers", "aa-language-models.json"),
  cacheTtlHours: 12,
}

export interface AAData {
  rows: AARow[]
  fetchedAt: string | null
  kind: "live" | "free" | "cache" | "offline"
  notes: string[]
}

export function cacheIsFresh(fetchedAt: string, now = Date.now(), ttlHours = AA.cacheTtlHours): boolean {
  const age = now - Date.parse(fetchedAt)
  return Number.isFinite(age) && age >= 0 && age < ttlHours * 3_600_000
}

function readCache(file: string): { payload: unknown; fetchedAt: string } | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return { payload: raw.payload, fetchedAt: raw.fetchedAt }
  } catch {
    return null
  }
}

export interface LoadOptions {
  offline?: string
  refresh?: boolean
  env?: Record<string, string | undefined>
  fetchFn?: typeof fetch
  cacheFile?: string
  now?: number
}

/** Cached for 12 h; /language/models, falling back to /free on 401/403; the cache backs a failed fetch. */
export async function loadAA(opts: LoadOptions = {}): Promise<AAData> {
  if (opts.offline) {
    const payload = JSON.parse(readFileSync(resolve(opts.offline), "utf8"))
    const stamp = (payload as { fetchedAt?: string })?.fetchedAt ?? null
    return { rows: normalizeRows(payload), fetchedAt: stamp, kind: "offline", notes: [`offline AA data from ${opts.offline}`] }
  }
  const file = opts.cacheFile ?? AA.cacheFile
  const cached = readCache(file)
  if (cached && !opts.refresh && cacheIsFresh(cached.fetchedAt, opts.now)) {
    return { rows: normalizeRows(cached.payload), fetchedAt: cached.fetchedAt, kind: "cache", notes: [] }
  }
  const key = (opts.env ?? process.env).ARTIFICIAL_ANALYSIS_API_KEY
  if (!key) throw new Error("ARTIFICIAL_ANALYSIS_API_KEY is not set (run with --env-file ~/work/.env, or pass --offline <file>)")
  const doFetch = opts.fetchFn ?? fetch
  const notes: string[] = []
  try {
    let path = AA.fullPath
    let kind: "live" | "free" = "live"
    let res = await doFetch(`${AA.baseUrl}${path}`, { headers: { "x-api-key": key } })
    if (res.status === 401 || res.status === 403) {
      notes.push(`${AA.fullPath} returned ${res.status} (needs a Pro+ key): using ${AA.freePath}, which lacks most high-effort, coding and cost data`)
      path = AA.freePath
      kind = "free"
      res = await doFetch(`${AA.baseUrl}${path}`, { headers: { "x-api-key": key } })
    }
    if (!res.ok) throw new Error(`AA ${res.status} ${res.statusText}`)
    const payload = await res.json()
    const fetchedAt = new Date(opts.now ?? Date.now()).toISOString()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ fetchedAt, url: `${AA.baseUrl}${path}`, kind, payload }))
    return { rows: normalizeRows(payload), fetchedAt, kind, notes }
  } catch (error) {
    if (!cached) throw error
    notes.push(`AA fetch failed (${(error as Error).message}): using the cached response`)
    return { rows: normalizeRows(cached.payload), fetchedAt: cached.fetchedAt, kind: "cache", notes }
  }
}

// ---------------------------------------------------------------------------------------------
// mapping table entries to pi models and AA rows
// ---------------------------------------------------------------------------------------------

/** Table model names whose AA base name is not their normalized id. */
const AA_ALIASES: Record<string, string> = {
  opus: "claudeopus55",
  sonnet: "claudesonnet55",
  haiku: "claudehaiku45",
  fable: "claudefable51",
  k3: "kimik3",
  "k3-256k": "kimik3256k",
}

const aaKey = (entry: TableEntry): string => {
  const tail = entry.model.split("/").pop()!
  return AA_ALIASES[tail] ?? normalizeName(tail)
}

/** The AA row at the entry's own effort. A row at another effort is never a substitute. */
export function matchRow(entry: TableEntry, rows: AARow[]): RowMatch {
  const mine = rows.filter((r) => r.baseKey === aaKey(entry))
  if (mine.length === 0) return { status: "no-aa", row: null, available: [] }
  const available = mine.map((r) => r.effort ?? "unmarked")
  const exact = entry.effort
    ? mine.find((r) => r.effort === entry.effort)
    : mine.every((r) => r.effort == null)
      ? mine[0]
      : undefined
  // a model AA lists with no effort marker at all has one row, whatever effort is asked for
  const only = mine.every((r) => r.effort == null) ? mine[0] : undefined
  const row = exact ?? only ?? null
  return { status: row ? "measured" : "missing", row, available }
}

const piKey = (provider: string, id: string) => `${provider}/${id}`

// ---------------------------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------------------------

/** Table entries pi no longer lists, and entries that name a thinking level for a model without one. */
export function checkAgainstPi(entries: TableEntry[], piModels: PiModel[]): Proposal[] {
  const known = new Map(piModels.map((m) => [piKey(m.provider, m.id), m]))
  const out: Proposal[] = []
  for (const e of entries) {
    if (e.harness !== "pi") continue
    const found = known.get(piKey(e.provider!, e.model))
    if (!found) {
      out.push({
        kind: "remove",
        role: e.role,
        text: `${e.raw}: pi no longer lists ${e.provider}/${e.model} (provider without credentials, or the model was renamed); remove or replace it`,
      })
    } else if (e.effort && e.effort !== "off" && !found.thinking) {
      out.push({ kind: "note", role: e.role, text: `${e.raw}: pi lists ${e.provider}/${e.model} without thinking levels, so ":${e.effort}" has no effect` })
    }
  }
  return out
}

/** pi models of the covered providers that no role uses and the table does not skip. */
export function checkCoverage(entries: TableEntry[], piModels: PiModel[], providers: string[], skip: string[] = []): Proposal[] {
  const used = new Set(entries.filter((e) => e.harness === "pi").map((e) => piKey(e.provider!, e.model)))
  for (const raw of skip) used.add(raw.replace(/^pi:/, ""))
  return piModels
    .filter((m) => providers.includes(m.provider) && !used.has(piKey(m.provider, m.id)))
    .map((m) => ({
      kind: "add" as const,
      role: null,
      text: `pi:${m.provider}/${m.id}: available in pi and used by no role; add it to a role or note why it stays out`,
    }))
}

/** Score gap (Intelligence points) above which a later entry counts as clearly better. */
export const REORDER_MARGIN = 3

/** Same-effort, measured AA rows that contradict the order of a role's entries. */
export function checkOrder(entries: TableEntry[], rows: AARow[], margin = REORDER_MARGIN): Proposal[] {
  const out: Proposal[] = []
  const roles = [...new Set(entries.map((e) => e.role))]
  for (const role of roles) {
    const chain = entries
      .filter((e) => e.role === role)
      .map((e) => ({ e, match: matchRow(e, rows) }))
      .filter((x) => x.match.row?.intelligence != null)
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const a = chain[i]
        const b = chain[j]
        if ((a.e.effort ?? "") !== (b.e.effort ?? "")) continue // different efforts are not comparable
        const gap = b.match.row!.intelligence! - a.match.row!.intelligence!
        if (gap >= margin) {
          out.push({
            kind: "reorder",
            role,
            text:
              `${b.e.raw} is listed after ${a.e.raw}, but AA's Intelligence index at ${a.e.effort ?? "the same"} effort has it ${gap.toFixed(1)} points higher ` +
              `(${b.match.row!.intelligence!.toFixed(1)} vs ${a.match.row!.intelligence!.toFixed(1)}); consider moving it up unless quota or family rules say otherwise`,
          })
        }
      }
    }
  }
  return out
}

export function dataNotes(data: AAData | null, reason: string | null, now = Date.now()): Proposal[] {
  if (!data) return [{ kind: "note", role: null, text: `AA data unavailable (${reason}): the reorder check and the gaps report were skipped` }]
  const out: Proposal[] = data.notes.map((text) => ({ kind: "note" as const, role: null, text }))
  if (data.fetchedAt) {
    const hours = (now - Date.parse(data.fetchedAt)) / 3_600_000
    if (Number.isFinite(hours)) out.push({ kind: "note", role: null, text: `AA data (${data.kind}) is ${hours < 1 ? "under an hour" : `${Math.round(hours)} h`} old` })
  } else out.push({ kind: "note", role: null, text: `AA data (${data.kind}) carries no timestamp` })
  return out
}

/** Per table entry: does AA have a row at the entry's own effort, and what does it say. */
export function formatGaps(entries: TableEntry[], rows: AARow[]): string {
  const table: string[][] = [["role", "entry", "AA row", "intelligence", "coding", "cost/task", "s/task", "AA has"]]
  for (const e of entries) {
    const m = matchRow(e, rows)
    const f = (v: number | null, d = 1) => (v == null ? "-" : v.toFixed(d))
    table.push([
      e.role,
      e.raw,
      m.status === "measured" ? "measured" : m.status === "missing" ? "missing at this effort" : "not in AA",
      f(m.row?.intelligence ?? null),
      f(m.row?.coding ?? null),
      f(m.row?.cost ?? null, 2),
      f(m.row?.speedSeconds ?? null, 0),
      m.available.join(",") || "-",
    ])
  }
  const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)))
  return table.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd()).join("\n")
}

const SIGN: Record<Proposal["kind"], string> = { remove: "-", add: "+", reorder: "~", note: "!" }

export function formatProposals(proposals: Proposal[]): string {
  if (proposals.length === 0) return "no diffs proposed"
  return proposals.map((p) => `${SIGN[p.kind]} ${p.kind}${p.role ? ` [${p.role}]` : ""}: ${p.text}`).join("\n")
}

/** Non-zero when the table names a model pi lacks or omits one pi offers: the two checks that need a human. */
export function exitCode(proposals: Proposal[]): number {
  return proposals.some((p) => p.kind === "remove" || p.kind === "add") ? 1 : 0
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const DEFAULT_TABLE = resolve(import.meta.dir, "..", "..", "src/plugins/team-lead/skills/team-lead/default-models.yaml")

export interface Args {
  table: string
  offline?: string
  refresh: boolean
  piList?: string
  providers: string[]
  gaps: boolean
  help: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { table: DEFAULT_TABLE, refresh: false, providers: ["openai-codex", "kimi-coding"], gaps: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return value
    }
    switch (argv[i]) {
      case "--table": args.table = resolve(next()); break
      case "--offline": args.offline = next(); break
      case "--refresh": args.refresh = true; break
      case "--pi-list": args.piList = next(); break
      case "--providers": args.providers = next().split(",").map((p) => p.trim()).filter(Boolean); break
      case "--gaps": args.gaps = true; break
      case "--help": case "-h": args.help = true; break
      default: throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  return args
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    const source = readFileSync(new URL(import.meta.url).pathname, "utf8")
    console.log(source.slice(source.indexOf("/**") + 3, source.indexOf("*/")).split("\n").map((l) => l.replace(/^ \* ?/, "")).join("\n").trim())
    return 0
  }
  if (!existsSync(args.table)) throw new Error(`no such table: ${args.table}`)
  const text = readFileSync(args.table, "utf8")
  const entries = parseTable(text)
  const skip = parseSkips(text)
  const piModels = loadPiModels(args.piList)

  let data: AAData | null = null
  let reason: string | null = null
  try {
    data = await loadAA({ offline: args.offline, refresh: args.refresh })
  } catch (error) {
    reason = (error as Error).message
  }

  const proposals = [
    ...checkAgainstPi(entries, piModels),
    ...checkCoverage(entries, piModels, args.providers, skip),
    ...(data ? checkOrder(entries, data.rows) : []),
    ...dataNotes(data, reason),
  ]
  console.log(formatProposals(proposals))
  if (args.gaps && data) console.log("\n" + formatGaps(entries, data.rows))
  return exitCode(proposals)
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`check: ${(error as Error).message}`)
      process.exit(2)
    },
  )
}
