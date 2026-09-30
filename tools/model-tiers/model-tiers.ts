#!/usr/bin/env bun
/**
 * model-tiers — turn live Artificial Analysis data into an ordered model chain per tier,
 * restricted to models the operator can actually run in pi.
 *
 * ## Usage
 *
 *   bun --env-file ~/work/.env tools/model-tiers/model-tiers.ts [options]
 *
 *   --offline <file>       read AA data from a local snapshot instead of the API
 *                          (e.g. agent/llms.json, an older snapshot without cost-per-task)
 *   --refresh              ignore the response cache and refetch
 *   --json                 machine-readable output: { tier: ["provider/model[:thinking]", ...], ... } plus metrics
 *   --pinball <tier>       print a pi-pinball `models` array for one tier
 *                          (schema: [{ "provider": ..., "id": ..., "thinking"? }] — pinball itself keys on provider/id)
 *   --write-defaults [p]   write the generated chains to the plugin's default-models.yaml
 *                          (default: src/plugins/team-lead/skills/team-lead/default-models.yaml)
 *   --config <file>        config file (default: tools/model-tiers/config.json)
 *   --pi-list <file>       use a saved `pi --list-models` dump instead of running pi
 *   --help                 this header
 *
 * ## Data sources
 *
 *  - Artificial Analysis v2: /language/models (Pro+) with automatic fallback to
 *    /language/models/free on 401/403, with a visible warning naming the fields lost.
 *    Key comes from ARTIFICIAL_ANALYSIS_API_KEY; it is never printed or written to disk.
 *    Responses are cached in ~/.cache/model-tiers (TTL in config) and reused on network failure.
 *  - pi's own model registry (`pi --list-models`) for the runnable provider/model ids,
 *    context windows, and reasoning support.
 *
 * ## Scoring (all tunables in config.json)
 *
 *  capability  weighted blend of AA indices (coding 0.6 / intelligence 0.4, plus a
 *              software-engineering index if a response ever carries one), renormalized
 *              over the indices that are actually present.
 *  cost        AA cost per Intelligence-Index task when present; otherwise blended 3:1
 *              token price (reported, or computed from input/output when only those exist).
 *              Both are flagged in the output. Cost from a subscription provider is scaled
 *              by cost.subscriptionWeight (< 1, never 0).
 *  speed       end-to-end response time per task when the endpoint has it, else
 *              output tokens per task / median tokens per second, else 1 / tokens-per-second.
 *  free        models absent from AA (config.free) are never ranked: each tier's chain gets the
 *              `first-fallback` model right after its primary and the `last` model at the end,
 *              cost 0, quality from a sourced override, availability flagged "unknown" until
 *              the provider says otherwise. config.free.excludeTiers opts a tier out.
 *  quota       operator plan limits (requests per 5h) floor the loop-heavy tiers: a model with
 *              fewer than quota.tiers[tier] requests/5h may follow the primary but never be it.
 *  capability  lead/senior/dev rank by capability in buckets of `capabilityBucket` points, then
 *  ranking     cost, so cost only breaks near-ties. `maxCapabilityRatio` keeps the overall best
 *              models out of dev/intern. A coding index missing from the data (the free endpoint
 *              lacks it for most rows) is estimated from the intelligence index and flagged.
 *  operator    config.operatorRanking (best first) is checked against every generated chain; each
 *  ranking     pair a chain orders against it becomes a `ranking:` warning. Models in one group are
 *              equals: they share a tier's capability floor, and the first-fallback free model is
 *              placed after the last model ranked above it.
 *  harnesses   config.extraModels adds models pi does not list (Claude Code's opus/sonnet/haiku);
 *              config.harnesses maps a provider to its output prefix (claude:opus vs pi:...).
 *  absent      config.aaAbsent places a ranked model AA does not carry (Kimi K3 on the free
 *              endpoint) between two known models; measured AA data wins when it appears.
 *
 * ## Tests
 *
 *   bun test tools/model-tiers
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

export type Billing = "subscription" | "metered" | "free"
export type Effort = "max" | "xhigh" | "high" | "medium" | "low" | "off"
export type CostBasis = "per-task" | "blended-token-price" | "computed-token-price" | "free" | "unknown"
export type SpeedBasis = "end-to-end" | "tokens-per-task" | "throughput-inverse" | "external-estimate" | "unknown"
export type RankKey = "capability" | "cost" | "capabilityPerCost" | "speed"

export interface PiModel {
  provider: string
  id: string
  contextTokens: number | null
  maxOutputTokens: number | null
  thinking: boolean
  images: boolean
}

export interface BlockRule {
  match: string
  reason: string
}

export interface QuotaRule {
  requests_per_5h?: number | null
  unlimited?: boolean
  usd_cap?: number | null
  note?: string
}

export interface TierConfig {
  minCapabilityRatio?: number
  /** capability points that count as a tie when ranking by "capability" (cost then breaks the tie) */
  capabilityBucket?: number
  /** keep models above this share of the overall best capability out of the tier (reserves top models for top tiers) */
  maxCapabilityRatio?: number
  rankBy: RankKey[]
  thinking: Effort | "off"
  axis?: "context-cost"
}

export interface AbsentModel {
  name: string
  /** normalized base keys of the models it sits between, better one first */
  between: [string, string]
  /** 0 = as good as the first neighbor, 1 = as good as the second; default 0.5 */
  fraction?: number
  source: string
}

/**
 * A free-tier model absent from Artificial Analysis. Placed by policy, never ranked:
 * `first-fallback` = the slot right after a tier's primary, `last` = the end of the chain.
 */
export interface FreeModelRule {
  position: "first-fallback" | "last"
  qualityOverride: { capability: number; source: string; speedSeconds?: number }
  note?: string
}

export interface FreeConfig {
  /** when the free offer ends; "unknown" while the provider has not said */
  availableUntil: string
  /** tiers that get no free fallbacks */
  excludeTiers?: string[]
  /** keyed by pi provider/model */
  models: Record<string, FreeModelRule>
}

export interface Config {
  api: { baseUrl: string; fullPath: string; freePath: string; cacheDir: string; cacheTtlHours: number }
  capability: { weights: Record<string, number> }
  cost: {
    subscriptionWeight: number
    defaultBilling: Billing
    /** `weight` overrides subscriptionWeight for one provider (scarce quota => closer to 1) */
    providers: Record<string, { billing: Billing; weight?: number }>
  }
  blocked?: BlockRule[]
  quota?: {
    source?: string
    tiers?: Record<string, number>
    providers?: Record<string, { plan?: string; models?: Record<string, QuotaRule> }>
  }
  free?: FreeConfig
  /** models a harness can run that pi's registry does not list (e.g. Claude Code's opus/sonnet/haiku) */
  extraModels?: PiModel[]
  /** provider -> harness prefix in generated output; providers not listed use "pi" */
  harnesses?: Record<string, string>
  /** ranked models absent from the AA dataset, placed by the operator's ranking */
  aaAbsent?: AbsentModel[]
  /** best first; models in one group are equal. Entries are globs on "provider/modelId". */
  operatorRanking?: string[][]
  providerStatus?: { asOf?: string; providers?: Record<string, { state: string; note?: string }> }
  chainLength: number
  diversity: { minProviders: number }
  escalation: { allow: boolean; scope: "model" | "entry" }
  research: { minContextTokens: number; prefer: string[] }
  metricsFallback?: "flagship"
  tiers: Record<string, TierConfig>
  aliases?: Record<string, string[]>
}

export interface AAModel {
  slug: string
  name: string
  baseKey: string
  baseLabel: string
  effort: Effort | null
  creator: string | null
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
  softwareEngineeringIndex: number | null
  capability: number | null
  cost: number | null
  costBasis: CostBasis
  speedSeconds: number | null
  speedBasis: SpeedBasis
  contextWindow: number | null
  releaseDate: string | null
  /** true when coding was estimated from the intelligence index (see imputeCoding) */
  codingImputed?: boolean
  /** set on rows that are not measured AA data */
  note?: string
}

/** One pi-runnable model (provider + base id) with every AA variant that maps to it. */
export interface Candidate {
  provider: string
  baseId: string
  supportsThinking: boolean
  contextTokens: number | null
  /** AA rows keyed by reasoning effort; "none" = row with no effort marker (the flagship row). */
  variants: Map<string, AAModel>
  baseLabel: string
}

export interface ChainEntry {
  piId: string
  provider: string
  modelId: string
  thinking: string | null
  aaSlug: string
  aaName: string
  capability: number | null
  cost: number | null
  costBasis: CostBasis
  effectiveCost: number | null
  billing: Billing
  speedSeconds: number | null
  speedBasis: SpeedBasis
  requestsPer5h: number | null
  /** true when the model is below the tier's quota floor and so cannot be the primary */
  fallbackOnly?: boolean
  /** set on free-model entries placed by policy: where the quality figure came from */
  freeSource?: string
  availableUntil?: string
  reason: string
}

export interface TierMetrics {
  piId: string
  aaSlug: string
  aaName: string
  capability: number | null
  costPerTask: number | null
  costBasis: CostBasis
  effectiveCost: number | null
  billing: Billing
  speedSeconds: number | null
  speedBasis: SpeedBasis
  requestsPer5h: number | "unlimited" | null
  freeSource?: string
  availableUntil?: string
  reason: string
}

/** A free-tier model that pi can actually run, with its placement rule. */
export interface FreeModel {
  piModel: PiModel
  rule: FreeModelRule
}

export interface MetaOutput {
  dataKind: AADataset["kind"]
  dataTimestamp: string | null
  models: number
  piModels: number
  candidates: number
  unmapped: number
  unmappedModels: string[]
  blockedModels: string[]
  warnings: string[]
  providerStatus?: Config["providerStatus"]
}

/** Flat tier keys -> ordered chain, plus metrics and run meta. */
export type JsonOutput = {
  metrics: Record<string, TierMetrics[]>
  meta: MetaOutput
  [tier: string]: string[] | Record<string, TierMetrics[]> | MetaOutput
}

/** One pi-pinball bounce-list entry; `thinking` is advisory (pinball keys on provider/id). */
export interface PinballEntry {
  provider: string
  id: string
  thinking?: string
}

export interface TierChain {
  tier: string
  rule: string
  floor: string
  entries: ChainEntry[]
  poolSize: number
  diversity: "ok" | "single-provider" | "chain-too-short" | "no-candidates"
  reserved: string[]
}

export interface AADataset {
  models: AAModel[]
  timestamp: string | null
  kind: "live" | "free" | "cache" | "offline"
  warnings: string[]
}

// ---------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dir
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..")
export const DEFAULT_CONFIG_PATH = join(SCRIPT_DIR, "config.json")
export const DEFAULT_OUTPUT_PATH = join(
  REPO_ROOT,
  "src/plugins/team-lead/skills/team-lead/default-models.yaml",
)

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config
  const errors = validateConfig(config)
  if (errors.length > 0) {
    throw new Error(`invalid config ${path}:\n  - ${errors.join("\n  - ")}`)
  }
  return config
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = []
  const weight = config.cost?.subscriptionWeight
  if (typeof weight !== "number" || !(weight > 0)) {
    errors.push("cost.subscriptionWeight must be a number > 0 (never 0: a subscription model is cheap, not free)")
  }
  for (const [provider, rule] of Object.entries(config.cost?.providers ?? {})) {
    if (rule.weight != null && !(rule.weight > 0)) errors.push(`cost.providers.${provider}.weight must be > 0`)
  }
  if (!config.tiers || Object.keys(config.tiers).length === 0) errors.push("tiers must be non-empty")
  for (const [name, tier] of Object.entries(config.tiers ?? {})) {
    if (!Array.isArray(tier.rankBy) || tier.rankBy.length === 0) {
      errors.push(`tiers.${name}.rankBy must be a non-empty array`)
    }
    for (const key of tier.rankBy ?? []) {
      if (!["capability", "cost", "capabilityPerCost", "speed"].includes(key)) {
        errors.push(`tiers.${name}.rankBy has unknown key "${key}"`)
      }
    }
    if (tier.maxCapabilityRatio != null && !(tier.maxCapabilityRatio > 0 && tier.maxCapabilityRatio <= 1)) {
      errors.push(`tiers.${name}.maxCapabilityRatio must be in (0, 1]`)
    }
    if (tier.minCapabilityRatio != null && (tier.minCapabilityRatio < 0 || tier.minCapabilityRatio > 1)) {
      errors.push(`tiers.${name}.minCapabilityRatio must be between 0 and 1`)
    }
  }
  if (!(config.chainLength > 0)) errors.push("chainLength must be > 0")
  const quotaTierKeys = new Set(Object.keys(config.tiers ?? {}))
  for (const tier of Object.keys(config.quota?.tiers ?? {})) {
    if (!quotaTierKeys.has(tier)) errors.push(`quota.tiers.${tier} has no matching tier`)
  }
  const freeModels = Object.entries(config.free?.models ?? {})
  for (const [id, rule] of freeModels) {
    if (!["first-fallback", "last"].includes(rule.position)) {
      errors.push(`free.models.${id}.position must be "first-fallback" or "last"`)
    }
    if (typeof rule.qualityOverride?.capability !== "number" || !rule.qualityOverride?.source) {
      errors.push(`free.models.${id}.qualityOverride needs a numeric capability and a source note`)
    }
  }
  if (freeModels.filter(([, r]) => r.position === "first-fallback").length > 1) {
    errors.push('free.models: at most one model may take position "first-fallback"')
  }
  if (freeModels.filter(([, r]) => r.position === "last").length > 1) {
    errors.push('free.models: at most one model may take position "last"')
  }
  for (const tier of config.free?.excludeTiers ?? []) {
    if (!quotaTierKeys.has(tier)) errors.push(`free.excludeTiers.${tier} has no matching tier`)
  }
  return errors
}

/** Resolve config.free against pi's registry; a listed model pi cannot run is reported, not fatal. */
export function resolveFreeModels(
  config: Config,
  piModels: PiModel[],
): { free: FreeModel[]; warnings: string[] } {
  const free: FreeModel[] = []
  const warnings: string[] = []
  for (const [id, rule] of Object.entries(config.free?.models ?? {})) {
    const found = piModels.find((m) => `${m.provider}/${m.id}` === id)
    if (!found) warnings.push(`free model ${id} is not in pi's registry — no free fallback placed for it`)
    else if (blockedReason(config, found.provider, found.id)) {
      warnings.push(`free model ${id} is blocked by config — no free fallback placed for it`)
    } else free.push({ piModel: found, rule })
  }
  return { free, warnings }
}

function billingFor(config: Config, provider: string): Billing {
  return config.cost.providers?.[provider]?.billing ?? config.cost.defaultBilling ?? "metered"
}

/** Effective cost used for ranking: raw cost scaled down for subscription providers. */
export function effectiveCost(config: Config, cost: number | null, provider: string): number | null {
  if (cost == null) return null
  const factor =
    billingFor(config, provider) === "subscription"
      ? (config.cost.providers?.[provider]?.weight ?? config.cost.subscriptionWeight)
      : 1
  return cost * factor
}

// ---------------------------------------------------------------------------------------------
// blocking / quota
// ---------------------------------------------------------------------------------------------

/** Glob match supporting `*` anywhere; matches "provider/model" or a bare "provider". */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

export function blockedReason(config: Config, provider: string, modelId: string): string | null {
  for (const rule of config.blocked ?? []) {
    if (globMatch(rule.match, `${provider}/${modelId}`) || globMatch(rule.match, provider)) {
      return `${rule.match}: ${rule.reason}`
    }
  }
  return null
}

export function quotaFor(config: Config, provider: string, modelId: string): QuotaRule | null {
  return config.quota?.providers?.[provider]?.models?.[modelId] ?? null
}

export function requestsPer5h(config: Config, provider: string, modelId: string): number | null {
  const rule = quotaFor(config, provider, modelId)
  if (!rule) return null
  if (rule.unlimited) return Infinity
  return typeof rule.requests_per_5h === "number" ? rule.requests_per_5h : null
}

// ---------------------------------------------------------------------------------------------
// pi model registry
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
    const provider = parts[0]
    const maxOut = parseTokenCount(parts[parts.length - 3])
    const context = parseTokenCount(parts[parts.length - 4])
    const id = parts.slice(1, parts.length - 4).join(" ")
    if (!provider || !id) continue
    models.push({
      provider,
      id,
      contextTokens: context,
      maxOutputTokens: maxOut,
      thinking: thinking === "yes",
      images: images === "yes",
    })
  }
  return models
}

export async function loadPiModels(listFile?: string): Promise<PiModel[]> {
  if (listFile) return parsePiModels(readFileSync(listFile, "utf8"))
  const proc = Bun.spawnSync(["pi", "--list-models"], { stdout: "pipe", stderr: "pipe" })
  if (!proc.success) {
    throw new Error(
      "`pi --list-models` failed; run it in a configured pi environment or pass --pi-list <file> with a saved dump",
    )
  }
  const models = parsePiModels(proc.stdout.toString())
  if (models.length === 0) throw new Error("`pi --list-models` returned no models")
  return models
}

// ---------------------------------------------------------------------------------------------
// Artificial Analysis normalization
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
  "non reasoning": "off",
  "no reasoning": "off",
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
    // descriptive parentheticals: "(Adaptive Reasoning, Max Effort, Default Fallback)"
    if (/\bnon[- ]?reasoning\b/.test(text)) return "off"
    const effort = /\b(max|xhigh|high|medium|low|minimal)\s+effort\b/.exec(text)
    if (effort) return EFFORT_WORDS[effort[1]]
  }
  return null
}

export function parseBaseName(name: string, slug: string): { baseKey: string; baseLabel: string; effort: Effort | null } {
  const effort = parseEffort(name)
  const baseLabel = name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim() || slug
  return { baseKey: normalizeName(name) || normalizeName(slug), baseLabel, effort }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Read a nested value out of an untrusted JSON payload. */
export function dig<T = Record<string, unknown>>(root: unknown, ...path: string[]): T | undefined {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor == null || typeof cursor !== "object") return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor as T | undefined
}

/** Capability = weighted blend of present AA indices, renormalized over the present ones. */
export function computeCapability(
  evaluations: Record<string, unknown> | undefined,
  weights: Record<string, number>,
): number | null {
  const e = evaluations ?? {}
  const values: Record<string, number | null> = {
    coding: num(e.artificial_analysis_coding_index),
    intelligence: num(e.artificial_analysis_intelligence_index),
    software_engineering: num(e.software_engineering) ?? num(e.software_engineering_index),
  }
  let total = 0
  let weight = 0
  for (const [key, value] of Object.entries(values)) {
    const w = weights[key] ?? 0
    if (value == null || !(w > 0)) continue
    total += w * value
    weight += w
  }
  return weight > 0 ? total / weight : null
}

export function computeCost(row: Record<string, unknown>): { cost: number | null; basis: CostBasis } {
  const perTask = num(dig(row, "artificial_analysis_intelligence_index_cost", "cost_per_task", "total_cost"))
  if (perTask != null) return { cost: perTask, basis: "per-task" }
  const blended = num(dig(row, "pricing", "price_1m_blended_3_to_1"))
  if (blended != null) return { cost: blended, basis: "blended-token-price" }
  const input = num(dig(row, "pricing", "price_1m_input_tokens"))
  const output = num(dig(row, "pricing", "price_1m_output_tokens"))
  if (input != null && output != null) {
    return { cost: (3 * input + output) / 4, basis: "computed-token-price" }
  }
  return { cost: null, basis: "unknown" }
}

export function computeSpeed(row: Record<string, unknown>): { speedSeconds: number | null; basis: SpeedBasis } {
  const perf = dig(row, "performance") ?? row
  const e2e = num(dig(perf, "median_end_to_end_response_time_seconds"))
  if (e2e != null && e2e > 0) return { speedSeconds: e2e, basis: "end-to-end" }
  const tps = num(dig(perf, "median_output_tokens_per_second"))
  const outputTokens = num(dig(row, "artificial_analysis_intelligence_index_token_counts", "output_tokens"))
  if (tps != null && tps > 0 && outputTokens != null && outputTokens > 0) {
    return { speedSeconds: outputTokens / tps, basis: "tokens-per-task" }
  }
  if (tps != null && tps > 0) return { speedSeconds: 1 / tps, basis: "throughput-inverse" }
  return { speedSeconds: null, basis: "unknown" }
}

/** Accepts the live API envelope, the free envelope, agent/llms.json, or a bare array. */
export function normalizeAAModels(payload: unknown, weights: Record<string, number>): AAModel[] {
  const rawRows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(dig(payload, "data"))
      ? (dig(payload, "data") as unknown[])
      : []
  const models: AAModel[] = []
  const evals: (Record<string, unknown> | undefined)[] = []
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as Record<string, unknown>
    const name = row.name
    const slug = row.slug
    if (typeof name !== "string" || typeof slug !== "string") continue
    const { baseKey, baseLabel, effort } = parseBaseName(name, slug)
    const { cost, basis } = computeCost(row)
    const { speedSeconds, basis: speedBasis } = computeSpeed(row)
    const creator = dig(row, "model_creator", "name")
    const evaluations = dig(row, "evaluations")
    models.push({
      slug,
      name,
      baseKey,
      baseLabel,
      effort,
      creator: typeof creator === "string" ? creator : null,
      intelligenceIndex: num(dig(evaluations, "artificial_analysis_intelligence_index")),
      codingIndex: num(dig(evaluations, "artificial_analysis_coding_index")),
      agenticIndex: num(dig(evaluations, "artificial_analysis_agentic_index")),
      softwareEngineeringIndex:
        num(dig(evaluations, "software_engineering")) ?? num(dig(evaluations, "software_engineering_index")),
      capability: computeCapability(evaluations as Record<string, unknown> | undefined, weights),
      cost,
      costBasis: basis,
      speedSeconds,
      speedBasis,
      contextWindow: num(row.context_window_tokens),
      releaseDate: typeof row.release_date === "string" ? row.release_date : null,
    })
    evals.push(evaluations as Record<string, unknown> | undefined)
  }
  imputeCoding(models, evals, weights)
  return models
}

/** Minimum rows carrying both indices before a coding estimate is trusted. */
const MIN_IMPUTE_ROWS = 8

/**
 * The free endpoint omits the coding index for most rows. A capability blend that silently
 * drops coding for those rows is on a different scale than rows that have it, so estimate the
 * missing coding index with an ordinary least-squares fit of coding on intelligence over the
 * rows that carry both (minus one residual standard deviation, clamped to the observed range),
 * and flag every estimated row.
 */
export function imputeCoding(
  models: AAModel[],
  evals: (Record<string, unknown> | undefined)[],
  weights: Record<string, number>,
): void {
  const pairs = models.filter((m) => m.codingIndex != null && m.intelligenceIndex != null)
  if (pairs.length < MIN_IMPUTE_ROWS) return
  const n = pairs.length
  const mx = pairs.reduce((t, m) => t + m.intelligenceIndex!, 0) / n
  const my = pairs.reduce((t, m) => t + m.codingIndex!, 0) / n
  const sxx = pairs.reduce((t, m) => t + (m.intelligenceIndex! - mx) ** 2, 0)
  if (sxx === 0) return
  const slope = pairs.reduce((t, m) => t + (m.intelligenceIndex! - mx) * (m.codingIndex! - my), 0) / sxx
  const intercept = my - slope * mx
  const residuals = pairs.map((m) => m.codingIndex! - (slope * m.intelligenceIndex! + intercept))
  const sd = Math.sqrt(residuals.reduce((t, r) => t + r * r, 0) / Math.max(1, n - 2))
  const codings = pairs.map((m) => m.codingIndex!)
  const [lo, hi] = [Math.min(...codings), Math.max(...codings)]
  models.forEach((m, i) => {
    if (m.codingIndex != null || m.intelligenceIndex == null) return
    // one standard error below the fit, inside the observed range: an unmeasured model must not
    // out-rank a measured one on an extrapolation
    const estimate = Math.min(hi, Math.max(lo, slope * m.intelligenceIndex + intercept - sd))
    m.codingIndex = estimate
    m.codingImputed = true
    m.capability = computeCapability(
      { ...(evals[i] ?? {}), artificial_analysis_coding_index: estimate },
      weights,
    )
  })
}

/** Add rows for ranked models AA does not carry, placed between two known models by capability. */
export function injectAbsentModels(models: AAModel[], config: Config): AAModel[] {
  const out = [...models]
  const best = (key: string) => {
    const values = models.filter((m) => m.baseKey === key && m.capability != null).map((m) => m.capability!)
    return values.length > 0 ? Math.max(...values) : null
  }
  for (const absent of config.aaAbsent ?? []) {
    const baseKey = normalizeName(absent.name)
    if (models.some((m) => m.baseKey === baseKey)) continue // AA has it: measured data wins
    const upper = best(absent.between[0])
    const lower = best(absent.between[1])
    if (upper == null || lower == null) continue
    out.push({
      slug: `absent-${baseKey}`,
      name: absent.name,
      baseKey,
      baseLabel: absent.name,
      effort: null,
      creator: null,
      intelligenceIndex: null,
      codingIndex: null,
      agenticIndex: null,
      softwareEngineeringIndex: null,
      capability: upper + (lower - upper) * (absent.fraction ?? 0.5),
      cost: null,
      costBasis: "unknown",
      speedSeconds: null,
      speedBasis: "unknown",
      contextWindow: null,
      releaseDate: null,
      note: `capability inferred ${Math.round((absent.fraction ?? 0.5) * 100)}% of the way from ${absent.between[0]} down to ${absent.between[1]} (${absent.source})`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// mapping AA -> pi
// ---------------------------------------------------------------------------------------------

function piKeys(model: PiModel): string[] {
  const keys = [normalizeName(model.id), normalizeName(`${model.provider}/${model.id}`)]
  if (model.id.includes("/")) keys.push(normalizeName(model.id.split("/").pop()!))
  return keys
}

/** pi registry ids an AA model maps to: explicit aliases plus normalized-name matches. */
export function matchPiModels(
  model: AAModel,
  piModels: PiModel[],
  aliases: Record<string, string[]> = {},
): PiModel[] {
  const byId = new Map(piModels.map((m) => [`${m.provider}/${m.id}`, m]))
  const out: PiModel[] = []
  const seen = new Set<string>()
  const add = (key: string) => {
    if (seen.has(key)) return
    const found = byId.get(key)
    if (!found) return
    seen.add(key)
    out.push(found)
  }
  for (const alias of aliases[model.baseKey] ?? []) add(alias)
  if (out.length === 0) {
    for (const piModel of piModels) {
      if (piKeys(piModel).includes(model.baseKey)) add(`${piModel.provider}/${piModel.id}`)
    }
  }
  return out
}

/** Build one candidate per runnable pi model, with every AA variant that maps to it. */
export function buildCandidates(
  models: AAModel[],
  piModels: PiModel[],
  config: Config,
): { candidates: Candidate[]; unmapped: string[]; blocked: string[] } {
  const byKey = new Map<string, Candidate>()
  const unmappedBases = new Set<string>()
  const blocked: string[] = []
  for (const model of models) {
    const matches = matchPiModels(model, piModels, config.aliases)
    if (matches.length === 0) {
      unmappedBases.add(model.baseLabel)
      continue
    }
    for (const piModel of matches) {
      const key = `${piModel.provider}/${piModel.id}`
      if (blockedReason(config, piModel.provider, piModel.id)) {
        if (!blocked.includes(key)) blocked.push(key)
        continue
      }
      let candidate = byKey.get(key)
      if (!candidate) {
        candidate = {
          provider: piModel.provider,
          baseId: piModel.id,
          supportsThinking: piModel.thinking,
          contextTokens: piModel.contextTokens,
          variants: new Map(),
          baseLabel: model.baseLabel,
        }
        byKey.set(key, candidate)
      }
      const slot = model.effort ?? "none"
      const current = candidate.variants.get(slot)
      if (!current || preferRow(model, current)) candidate.variants.set(slot, model)
    }
  }
  return {
    candidates: [...byKey.values()],
    unmapped: [...unmappedBases].sort(),
    blocked: blocked.sort(),
  }
}

function preferRow(next: AAModel, current: AAModel): boolean {
  const a = next.capability ?? -Infinity
  const b = current.capability ?? -Infinity
  if (a !== b) return a > b
  return (next.releaseDate ?? "") > (current.releaseDate ?? "")
}

// ---------------------------------------------------------------------------------------------
// tier selection
// ---------------------------------------------------------------------------------------------

/** The AA row whose effort matches the tier's thinking level, else the flagship row. */
export function selectVariant(candidate: Candidate, thinking: string): { model: AAModel; from: string } {
  if (candidate.variants.has(thinking)) {
    return { model: candidate.variants.get(thinking)!, from: thinking }
  }
  for (const slot of ["none", "max", "xhigh", "high", "medium", "low", "off"]) {
    const model = candidate.variants.get(slot)
    if (model) return { model, from: slot === "none" ? "flagship" : slot }
  }
  const [first] = [...candidate.variants.values()]
  return { model: first, from: "only-variant" }
}

export function piIdFor(candidate: Candidate, thinking: string): { piId: string; thinking: string | null } {
  const suffix = candidate.supportsThinking && thinking !== "off" ? `:${thinking}` : ""
  return { piId: `${candidate.provider}/${candidate.baseId}${suffix}`, thinking: suffix ? thinking : null }
}

const RANK_LABELS: Record<RankKey, string> = {
  capability: "capability",
  cost: "cost",
  capabilityPerCost: "capability per $",
  speed: "speed",
}

interface Scored {
  candidate: Candidate
  entry: ChainEntry
  /** the AA row that supplied this entry's metrics */
  variant: AAModel
  /** effort slot that row came from ("high", "flagship", ...) */
  variantFrom: string
  rank: number
  diversitySwap?: boolean
  /** cost used for ranking when it differs from entry.effectiveCost (unknown-cost subscriptions) */
  sortCost?: number | null
}

function compareKey(a: Scored, b: Scored, key: RankKey, bucket = 0): number {
  const entryA = a.entry
  const entryB = b.entry
  switch (key) {
    case "capability": {
      const x = entryA.capability ?? -Infinity
      const y = entryB.capability ?? -Infinity
      if (bucket > 0 && Number.isFinite(x) && Number.isFinite(y)) {
        return Math.round(y / bucket) - Math.round(x / bucket)
      }
      return y === x ? 0 : y - x
    }
    case "cost": {
      const x = a.sortCost !== undefined ? a.sortCost : entryA.effectiveCost
      const y = b.sortCost !== undefined ? b.sortCost : entryB.effectiveCost
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return x - y
    }
    case "capabilityPerCost": {
      const x = valuePerCost(entryA)
      const y = valuePerCost(entryB)
      return y - x
    }
    case "speed": {
      const x = entryA.speedSeconds
      const y = entryB.speedSeconds
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return x - y
    }
  }
}

/** capability per effective dollar; unknown cost sorts last, a free model is unbeatable. */
export function valuePerCost(entry: ChainEntry): number {
  if (entry.capability == null) return -Infinity
  if (entry.effectiveCost == null) return -1
  if (entry.effectiveCost <= 0) return Infinity
  return entry.capability / entry.effectiveCost
}

export interface SelectOptions {
  /** higher tiers' top slots, already reserved */
  reserved: Set<string>
}

function identity(config: Config, candidate: Candidate, model: AAModel): string {
  return config.escalation.scope === "entry" ? `${candidate.provider}/${candidate.baseId}` : model.baseKey
}

/** prefer entries listed in config.research.prefer ahead of the rest (research axis only). */
function preferIndex(s: Scored, prefer: string[]): number {
  const key = `${s.entry.provider}/${s.entry.modelId}`
  const index = prefer.indexOf(key)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export function compareScored(
  a: Scored,
  b: Scored,
  rankBy: RankKey[],
  prefer: string[] = [],
  bucket = 0,
): number {
  if (prefer.length > 0) {
    const preferred = preferIndex(a, prefer) - preferIndex(b, prefer)
    if (preferred !== 0) return preferred
  }
  for (const key of rankBy) {
    const cmp = compareKey(a, b, key, bucket)
    if (cmp !== 0) return cmp
  }
  // deterministic tail: capability desc, then pi id asc
  const cap = (b.entry.capability ?? -Infinity) - (a.entry.capability ?? -Infinity)
  if (Number.isFinite(cap) && cap !== 0) return cap
  return a.entry.piId < b.entry.piId ? -1 : a.entry.piId > b.entry.piId ? 1 : 0
}

export function selectTier(
  tier: string,
  tierConfig: TierConfig,
  candidates: Candidate[],
  config: Config,
  reserved: Set<string>,
  /** chain slots held back for free fallbacks placed after ranking */
  freeSlots = 0,
  /** providers the free fallbacks add, counted towards chain diversity */
  freeProviders: Set<string> = new Set(),
): TierChain {
  const quotaFloor = config.quota?.tiers?.[tier] ?? 0
  const scored: Scored[] = candidates.map((candidate) => {
    const { model, from } = selectVariant(candidate, tierConfig.thinking)
    const cost = effectiveCost(config, model.cost, candidate.provider)
    const { piId, thinking } = piIdFor(candidate, tierConfig.thinking)
    const requests = requestsPer5h(config, candidate.provider, candidate.baseId)
    const entry: ChainEntry = {
      piId,
      provider: candidate.provider,
      modelId: candidate.baseId,
      thinking,
      aaSlug: model.slug,
      aaName: model.name,
      capability: model.capability,
      cost: model.cost,
      costBasis: model.costBasis,
      effectiveCost: cost,
      billing: billingFor(config, candidate.provider),
      speedSeconds: model.speedSeconds,
      speedBasis: model.speedBasis,
      requestsPer5h: requests,
      reason: "",
    }
    return { candidate, entry, variant: model, variantFrom: from, rank: 0 }
  })

  let pool = scored.filter((s) => !reserved.has(identity(config, s.candidate, s.variant)))
  // one bar for both ratios: the best model that may actually be primary, before any tier-local
  // filtering (a ceiling applied first would shrink the pool and compound with the floor)
  const overallBest = Math.max(
    ...scored.filter((s) => passesQuota(s, quotaFloor)).map((s) => s.entry.capability ?? -Infinity),
  )
  if (tierConfig.maxCapabilityRatio != null && Number.isFinite(overallBest)) {
    const ceiling = tierConfig.maxCapabilityRatio * overallBest
    pool = pool.filter((s) => s.entry.capability == null || s.entry.capability <= ceiling)
  }
  const researchTier = tierConfig.axis === "context-cost"
  if (researchTier) {
    const min = config.research?.minContextTokens ?? 0
    pool = pool.filter((s) => (s.candidate.contextTokens ?? 0) >= min)
  }
  if (tierConfig.minCapabilityRatio != null) {
    if (Number.isFinite(overallBest)) {
      const floor = tierConfig.minCapabilityRatio * overallBest
      const passing = pool.filter((s) => s.entry.capability != null && s.entry.capability >= floor)
      // the operator rates models in one ranking group as equals, so a model tied with a qualifier
      // qualifies too, even where estimated or measured capability puts it a little under the floor
      const groups = new Set(passing.map((s) => operatorRank(config, s.entry.provider, s.entry.modelId)))
      groups.delete(-1)
      pool = pool.filter(
        (s) => passing.includes(s) || groups.has(operatorRank(config, s.entry.provider, s.entry.modelId)),
      )
    }
  }

  // unknown cost on a subscription is plausibly cheaper than any metered price: rank it just ahead
  // of the cheapest known metered cost instead of last
  const meteredCosts = pool
    .filter((s) => s.entry.billing === "metered" && s.entry.effectiveCost != null)
    .map((s) => s.entry.effectiveCost!)
  for (const s of pool) {
    if (s.entry.effectiveCost == null && s.entry.billing === "subscription") {
      s.sortCost = meteredCosts.length > 0 ? Math.min(...meteredCosts) * 0.999 : 0
    }
  }

  const prefer = researchTier ? (config.research?.prefer ?? []) : []
  const ordered = [...pool].sort((a, b) =>
    compareScored(a, b, tierConfig.rankBy, prefer, tierConfig.capabilityBucket ?? 0),
  )
  // a model under the quota floor may follow the primary but never be it
  const primaryAt = ordered.findIndex((s) => passesQuota(s, quotaFloor))
  if (primaryAt > 0) ordered.unshift(...ordered.splice(primaryAt, 1))
  for (const s of ordered) s.entry.fallbackOnly = !passesQuota(s, quotaFloor)
  ordered.forEach((s, i) => (s.rank = i))
  const rule = tierConfig.rankBy.map((k) => RANK_LABELS[k]).join(", then ")
  const floors: string[] = []
  if (researchTier) floors.push(`context >= ${formatTokens(config.research?.minContextTokens ?? 0)}`)
  if (tierConfig.minCapabilityRatio != null) {
    floors.push(`capability >= ${Math.round(tierConfig.minCapabilityRatio * 100)}% of best`)
  }
  if (tierConfig.maxCapabilityRatio != null) {
    floors.push(`capability <= ${Math.round(tierConfig.maxCapabilityRatio * 100)}% of best`)
  }
  const floorText = floors.join(" + ")

  const selected = ordered.slice(0, Math.max(0, config.chainLength - freeSlots))
  const { chain, diversity } = applyDiversity(selected, ordered, config, freeProviders)

  for (const s of chain) {
    const flags: string[] = []
    if (s.entry.costBasis !== "per-task") flags.push(`cost from ${s.entry.costBasis}`)
    if (s.entry.billing === "subscription") {
      flags.push(`subscription cost x${config.cost.providers?.[s.entry.provider]?.weight ?? config.cost.subscriptionWeight}`)
    }
    if (s.sortCost !== undefined) flags.push("cost unknown (subscription): ranked ahead of metered prices")
    if (s.entry.requestsPer5h == null) flags.push("quota unknown")
    else if (s.entry.fallbackOnly) {
      flags.push(`fallback only: ${formatRequests(s.entry.requestsPer5h)} req/5h < ${quotaFloor}`)
    } else if (quotaFloor > 0) flags.push(`${formatRequests(s.entry.requestsPer5h)} req/5h`)
    if (s.variant.note) flags.push(s.variant.note)
    if (s.variant.codingImputed) flags.push("coding index estimated from intelligence")
    if (s.variantFrom !== tierConfig.thinking) flags.push(`metrics from ${s.variantFrom} variant`)
    if (s.entry.speedBasis === "throughput-inverse") flags.push("speed estimated from throughput")
    if (s.diversitySwap) flags.push("diversity swap-in")
    s.entry.reason = [`#${s.rank + 1} ${rule} (${floorText})`, ...flags].join("; ")
  }

  return {
    tier,
    rule,
    floor: floorText,
    entries: chain.map((s) => s.entry),
    poolSize: pool.length,
    diversity,
    reserved: [...reserved],
  }
}

function passesQuota(s: Scored, floor: number): boolean {
  if (floor <= 0) return true
  const requests = s.entry.requestsPer5h
  if (requests == null) return true // unknown cap: keep, flagged
  return requests >= floor
}

/** Ensure the chain spans minProviders providers where the pool allows it. */
export function applyDiversity(
  selected: Scored[],
  ordered: Scored[],
  config: Config,
  extraProviders: Set<string> = new Set(),
): { chain: Scored[]; diversity: TierChain["diversity"] } {
  const minProviders = config.diversity?.minProviders ?? 2
  if (selected.length + extraProviders.size < minProviders) {
    return { chain: selected, diversity: "chain-too-short" }
  }
  const providers = new Set([...selected.map((s) => s.entry.provider), ...extraProviders])
  if (providers.size >= minProviders) return { chain: selected, diversity: "ok" }
  const outsider = ordered.find((s) => !providers.has(s.entry.provider))
  if (!outsider || selected.length === 0) return { chain: selected, diversity: "single-provider" }
  outsider.diversitySwap = true
  const chain = [...selected.slice(0, -1), outsider].sort((a, b) => a.rank - b.rank)
  return { chain, diversity: "ok" }
}

/** Free-model entry for one tier: quality from the override, cost 0, no quota cap. */
function freeEntry(model: FreeModel, tierConfig: TierConfig, config: Config): ChainEntry {
  const { piModel, rule } = model
  const suffix = piModel.thinking && tierConfig.thinking !== "off" ? `:${tierConfig.thinking}` : ""
  const requests = requestsPer5h(config, piModel.provider, piModel.id)
  const speed = rule.qualityOverride.speedSeconds ?? null
  const position = rule.position === "first-fallback" ? "first fallback after the primary" : "last resort"
  return {
    piId: `${piModel.provider}/${piModel.id}${suffix}`,
    provider: piModel.provider,
    modelId: piModel.id,
    thinking: suffix ? tierConfig.thinking : null,
    aaSlug: "-",
    aaName: `${piModel.id} (not in AA)`,
    capability: rule.qualityOverride.capability,
    cost: 0,
    costBasis: "free",
    effectiveCost: 0,
    billing: "free",
    speedSeconds: speed,
    speedBasis: speed == null ? "unknown" : "external-estimate",
    requestsPer5h: requests ?? Infinity,
    freeSource: rule.qualityOverride.source,
    availableUntil: config.free?.availableUntil ?? "unknown",
    reason:
      `free ${position}; quality override ${rule.qualityOverride.capability} (${rule.qualityOverride.source}); ` +
      `available until ${config.free?.availableUntil ?? "unknown"}` +
      (rule.note ? `; ${rule.note}` : ""),
  }
}

/** Index of the config.operatorRanking group a model belongs to (0 = best), or -1 when unranked. */
export function operatorRank(config: Config, provider: string, modelId: string): number {
  const id = `${provider}/${modelId}`
  return (config.operatorRanking ?? []).findIndex((group) => group.some((pattern) => globMatch(pattern, id)))
}

/**
 * Splice free fallbacks into a ranked chain. The first-fallback model goes right after the last
 * entry the operator ranking puts above it, but never before the primary (a pinned entry, else
 * the first ranked one); with no ranking for it, right after the primary. The last-resort model
 * closes the chain. With no primary at all the free models are all there is; buildTiers warns.
 */
function placeFree(
  ranked: ChainEntry[],
  free: ChainEntry[],
  rules: FreeModel[],
  config: Config,
  minIndex = 0,
): ChainEntry[] {
  const chain = [...ranked]
  const at = (position: FreeModelRule["position"]) => {
    const i = rules.findIndex((m) => m.rule.position === position)
    return i === -1 ? null : free[i]
  }
  const first = at("first-fallback")
  const last = at("last")
  if (first) {
    const own = operatorRank(config, first.provider, first.modelId)
    // free models are fallbacks only: never before the primary (the entry at minIndex)
    const earliest = minIndex > 0 ? minIndex : 1 // after the pinned entries, else after the ranked primary
    let index = Math.min(earliest, chain.length)
    if (own >= 0) {
      chain.forEach((e, i) => {
        const rank = operatorRank(config, e.provider, e.modelId)
        if (i >= minIndex && rank !== -1 && rank < own) index = Math.max(index, i + 1)
      })
    }
    chain.splice(Math.min(index, chain.length), 0, first)
  }
  if (last) chain.push(last)
  return chain
}

/**
 * research.prefer models pi can run but AA data does not cover (the /free endpoint omits some):
 * they are pinned into the research chain anyway, with blank metrics, instead of vanishing.
 */
export function resolvePinned(
  config: Config,
  piModels: PiModel[],
  candidates: Candidate[],
): { pinned: PiModel[]; warnings: string[] } {
  const known = new Set(candidates.map((c) => `${c.provider}/${c.baseId}`))
  const pinned: PiModel[] = []
  const warnings: string[] = []
  for (const id of config.research?.prefer ?? []) {
    if (known.has(id)) continue
    const found = piModels.find((m) => `${m.provider}/${m.id}` === id)
    if (!found) warnings.push(`research.prefer ${id} is not in pi's registry — skipped`)
    else if (blockedReason(config, found.provider, found.id)) warnings.push(`research.prefer ${id} is blocked by config — skipped`)
    else if ((found.contextTokens ?? 0) < (config.research?.minContextTokens ?? 0)) {
      warnings.push(`research.prefer ${id} is below research.minContextTokens — skipped`)
    } else {
      pinned.push(found)
      warnings.push(`research.prefer ${id} has no Artificial Analysis data in this dataset — pinned without metrics`)
    }
  }
  return { pinned, warnings }
}

function pinnedEntry(model: PiModel, tierConfig: TierConfig, config: Config): ChainEntry {
  const suffix = model.thinking && tierConfig.thinking !== "off" ? `:${tierConfig.thinking}` : ""
  return {
    piId: `${model.provider}/${model.id}${suffix}`,
    provider: model.provider,
    modelId: model.id,
    thinking: suffix ? tierConfig.thinking : null,
    aaSlug: "-",
    aaName: `${model.id} (no AA data)`,
    capability: null,
    cost: null,
    costBasis: "unknown",
    effectiveCost: null,
    billing: billingFor(config, model.provider),
    speedSeconds: null,
    speedBasis: "unknown",
    requestsPer5h: requestsPer5h(config, model.provider, model.id),
    reason: "operator preference (research.prefer), pinned first; no Artificial Analysis data to rank it",
  }
}

export function buildTiers(
  allCandidates: Candidate[],
  config: Config,
  freeModels: FreeModel[] = [],
  pinnedModels: PiModel[] = [],
): { chains: TierChain[]; reserved: Set<string>; warnings: string[] } {
  const reserved = new Set<string>()
  const chains: TierChain[] = []
  const warnings: string[] = []
  // free models are placed by policy; they must never also be ranked
  const freeIds = new Set(Object.keys(config.free?.models ?? {}))
  const candidates = allCandidates.filter((c) => !freeIds.has(`${c.provider}/${c.baseId}`))
  for (const [tier, tierConfig] of Object.entries(config.tiers)) {
    const tierFree = config.free?.excludeTiers?.includes(tier) ? [] : freeModels
    const tierPinned = tierConfig.axis === "context-cost" ? pinnedModels : []
    const chain = selectTier(
      tier,
      tierConfig,
      candidates,
      config,
      reserved,
      tierFree.length + tierPinned.length,
      new Set([...tierFree.map((m) => m.piModel.provider), ...tierPinned.map((m) => m.provider)]),
    )
    if (tierPinned.length > 0) {
      chain.entries = [...tierPinned.map((m) => pinnedEntry(m, tierConfig, config)), ...chain.entries]
    }
    if (tierFree.length > 0) {
      const entries = tierFree.map((m) => freeEntry(m, tierConfig, config))
      chain.entries = placeFree(chain.entries, entries, tierFree, config, tierPinned.length)
    }
    chains.push(chain)
    if (config.escalation.allow || chain.entries.length === 0) continue
    const top = chain.entries[0]
    const topModel = candidates.find(
      (c) => c.provider === top.provider && c.baseId === top.modelId,
    )
    if (topModel) {
      for (const model of topModel.variants.values()) reserved.add(identity(config, topModel, model))
    } else if (!top.reason.startsWith("operator preference")) {
      warnings.push(
        `${tier}: its primary ${top.piId} is not a ranked candidate (free or pinned), so the tier reserves nothing against escalation`,
      )
    }
  }
  return { chains, reserved, warnings }
}

// ---------------------------------------------------------------------------------------------
// fetching + cache
// ---------------------------------------------------------------------------------------------

const LOST_ON_FREE = [
  "per-benchmark evaluations (livecodebench, terminalbench_*, scicode, ...)",
  "reasoning_model flag",
  "context_window_tokens",
  "Intelligence-Index token counts",
  "blended 3:1 pricing (cost falls back to input/output prices)",
  "end-to-end response time (speed falls back to token throughput)",
]

function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

export function cacheFile(config: Config): string {
  return join(expandTilde(config.api.cacheDir), "aa-language-models.json")
}

export function readCache(config: Config): { payload: unknown; fetchedAt: string } | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(config), "utf8"))
    return { payload: raw.payload, fetchedAt: raw.fetchedAt }
  } catch {
    return null
  }
}

export function writeCache(config: Config, payload: unknown, url: string, kind: string): void {
  const file = cacheFile(config)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), url, kind, payload }))
}

export function cacheIsFresh(config: Config, fetchedAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(fetchedAt)
  return Number.isFinite(age) && age >= 0 && age < config.api.cacheTtlHours * 3_600_000
}

export interface FetchOptions {
  env?: Record<string, string | undefined>
  fetchFn?: typeof fetch
  refresh?: boolean
  now?: Date
}

export async function loadAADataset(
  config: Config,
  opts: FetchOptions & { offline?: string } = {},
): Promise<AADataset> {
  const warnings: string[] = []
  if (opts.offline) {
    const payload = JSON.parse(readFileSync(resolve(opts.offline), "utf8"))
    const stamp = (payload as any)?.fetchedAt ?? (payload as any)?.timestamp ?? null
    return {
      models: normalizeAAModels(payload, config.capability.weights),
      timestamp: typeof stamp === "string" ? stamp : null,
      kind: "offline",
      warnings: [`using offline AA data from ${opts.offline} (not live; no cache written)`],
    }
  }

  const cached = readCache(config)
  if (cached && !opts.refresh && cacheIsFresh(config, cached.fetchedAt, opts.now?.getTime())) {
    return {
      models: normalizeAAModels(cached.payload, config.capability.weights),
      timestamp: cached.fetchedAt,
      kind: "cache",
      warnings: [`using cached AA response from ${cached.fetchedAt}`],
    }
  }

  const key = (opts.env ?? process.env).ARTIFICIAL_ANALYSIS_API_KEY
  if (!key) {
    throw new Error(
      "ARTIFICIAL_ANALYSIS_API_KEY is not set.\n" +
        "  run: bun --env-file ~/work/.env tools/model-tiers/model-tiers.ts\n" +
        "  or:  export ARTIFICIAL_ANALYSIS_API_KEY=... (never commit it)\n" +
        "  or:  --offline agent/llms.json",
    )
  }

  const doFetch = opts.fetchFn ?? fetch
  const { baseUrl, fullPath, freePath } = config.api
  const fetchOne = async (path: string) => {
    const res = await doFetch(`${baseUrl}${path}`, { headers: { "x-api-key": key } })
    return { res, path }
  }

  try {
    let { res } = await fetchOne(fullPath)
    let kind: "live" | "free" = "live"
    if (res.status === 401 || res.status === 403) {
      warnings.push(
        `${fullPath} returned ${res.status} (needs a Pro+ key) — falling back to ${freePath}. ` +
          `Lost on the free endpoint: ${LOST_ON_FREE.join(", ")}.`,
      )
      ;({ res } = await fetchOne(freePath))
      kind = "free"
    }
    if (!res.ok) throw new Error(`AA ${res.status} ${res.statusText}`)
    const payload = await res.json()
    writeCache(config, payload, `${baseUrl}${res.url.includes(freePath) ? freePath : fullPath}`, kind)
    return {
      models: normalizeAAModels(payload, config.capability.weights),
      timestamp: new Date().toISOString(),
      kind,
      warnings,
    }
  } catch (error) {
    if (cached) {
      warnings.push(
        `AA fetch failed (${(error as Error).message}) — falling back to the cached response from ${cached.fetchedAt}`,
      )
      return {
        models: normalizeAAModels(cached.payload, config.capability.weights),
        timestamp: cached.fetchedAt,
        kind: "cache",
        warnings,
      }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(value)
}

function formatRequests(value: number | null): string {
  if (value == null) return "unknown"
  if (value === Infinity) return "unlimited"
  return value.toLocaleString("en-US")
}

function formatCost(entry: ChainEntry): string {
  if (entry.cost == null) return "-"
  if (entry.billing === "free") return "free"
  const cost = entry.cost < 0.01 ? entry.cost.toFixed(4) : entry.cost.toFixed(2)
  const effective =
    entry.effectiveCost != null && entry.effectiveCost !== entry.cost
      ? ` (~${entry.effectiveCost.toFixed(4)} eff)`
      : ""
  return `${cost}${effective}`
}

export function formatTable(chains: TierChain[], meta: MetaOutput): string {
  const lines: string[] = []
  for (const warning of (meta.warnings as string[]) ?? []) lines.push(`! ${warning}`)
  const status = meta.providerStatus as Config["providerStatus"] | undefined
  if (status?.providers && Object.keys(status.providers).length > 0) {
    const parts = Object.entries(status.providers).map(
      ([provider, info]) => `${provider}: ${info.state}${info.note ? ` (${info.note})` : ""}`,
    )
    lines.push(`~ provider status as of ${status.asOf ?? "unknown"} — advisory, not used to exclude: ${parts.join("; ")}`)
  }
  if (meta.blockedModels?.length) {
    lines.push(`x blocked by config: ${(meta.blockedModels as string[]).join(", ")}`)
  }
  lines.push("")

  for (const chain of chains) {
    lines.push(
      `${chain.tier.toUpperCase()}  — ${chain.rule}, ${chain.floor}  |  pool ${chain.poolSize}, chain ${chain.entries.length}, diversity ${chain.diversity}`,
    )
    if (chain.entries.length === 0) {
      lines.push("  (no candidates)")
      lines.push("")
      continue
    }
    const rows: string[][] = [
      ["", "pi id", "model", "capability", "cost/task", "speed", "req/5h", "why"],
      ...chain.entries.map((e, i) => [
        `${i + 1}.`,
        e.piId,
        e.aaName,
        e.capability == null ? "-" : e.capability.toFixed(1),
        formatCost(e),
        e.speedSeconds == null ? "-" : `${e.speedSeconds.toFixed(2)}s`,
        formatRequests(e.requestsPer5h),
        e.reason,
      ]),
    ]
    const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)))
    for (const [i, row] of rows.entries()) {
      const line = row
        .map((cell, col) => (col === 6 || col === 0 ? cell.padEnd(widths[col]) : cell.padEnd(widths[col])))
        .join("  ")
        .trimEnd()
      lines.push("  " + line)
      if (i === 0) lines.push("  " + "-".repeat(Math.max(0, line.length - 2)))
    }
    lines.push("")
  }

  const unmapped = (meta.unmappedModels as string[]) ?? []
  lines.push(
    `unmapped AA models (${(meta.unmapped as number | undefined) ?? unmapped.length}): ${unmapped.length ? unmapped.join(", ") : "none"}`,
  )
  return lines.join("\n")
}

export function formatJson(chains: TierChain[], meta: MetaOutput): JsonOutput {
  const out: Record<string, string[] | Record<string, TierMetrics[]> | MetaOutput> = {}
  for (const chain of chains) out[chain.tier] = chain.entries.map((e) => e.piId)
  out.metrics = Object.fromEntries(
    chains.map((chain) => [
      chain.tier,
      chain.entries.map((e): TierMetrics => ({
        piId: e.piId,
        aaSlug: e.aaSlug,
        aaName: e.aaName,
        capability: e.capability,
        costPerTask: e.cost,
        costBasis: e.costBasis,
        effectiveCost: e.effectiveCost,
        billing: e.billing,
        speedSeconds: e.speedSeconds,
        speedBasis: e.speedBasis,
        requestsPer5h: e.requestsPer5h === Infinity ? "unlimited" : e.requestsPer5h,
        ...(e.freeSource ? { freeSource: e.freeSource, availableUntil: e.availableUntil } : {}),
        reason: e.reason,
      })),
    ]),
  )
  out.meta = meta
  return out as JsonOutput
}

/**
 * Ordering violations against config.operatorRanking: one warning per pair of ranked models a
 * chain puts in the opposite order to the operator's ranking, plus one per model
 * that appears in a chain without a place in the ranking (its order cannot be checked). Policy-
 * placed free models and the operator's pinned research preferences are exempt.
 */
export function rankingWarnings(chains: TierChain[], config: Config): string[] {
  const groups = config.operatorRanking ?? []
  if (groups.length === 0) return []
  const rankOf = (e: ChainEntry): number => operatorRank(config, e.provider, e.modelId)
  const warnings: string[] = []
  const unranked = new Set<string>()
  for (const chain of chains) {
    const ranked = chain.entries
      .filter((e) => !e.reason.startsWith("operator preference") && e.freeSource == null)
      .map((e) => ({ e, rank: rankOf(e) }))
    for (const x of ranked) {
      if (x.rank < 0 && !unranked.has(x.e.modelId)) {
        unranked.add(x.e.modelId)
        warnings.push(
          `ranking: ${x.e.piId} (first seen in ${chain.tier}${x === ranked[0] ? ", as its primary" : ""}) ` +
            "is not in operatorRanking, so its order cannot be checked",
        )
      }
    }
    ranked.splice(0, ranked.length, ...ranked.filter((x) => x.rank >= 0))
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        if (ranked[i].rank > ranked[j].rank) {
          warnings.push(
            `ranking: ${chain.tier} puts ${ranked[i].e.piId} before ${ranked[j].e.piId}, ` +
              `but the operator ranks ${ranked[j].e.modelId} above ${ranked[i].e.modelId}`,
          )
        }
      }
    }
  }
  return warnings
}

/** pi-pinball models array for one tier: [{ provider, id, thinking? }] (thinking is advisory). */
export function formatPinball(chain: TierChain, skipProviders: Set<string> = new Set()): PinballEntry[] {
  return chain.entries.filter((e) => !skipProviders.has(e.provider)).map((e) => {
    const entry: PinballEntry = { provider: e.provider, id: e.modelId }
    if (e.thinking) entry.thinking = e.thinking
    return entry
  })
}

export function renderDefaultsYaml(
  chains: TierChain[],
  meta: {
    generatedAt: string
    dataTimestamp: string | null
    dataKind: string
    command: string
    /** provider -> harness prefix; providers not listed run in pi */
    harnesses?: Record<string, string>
  },
): string {
  const lines = [
    "# GENERATED FILE — DO NOT EDIT BY HAND.",
    "# Generated by tools/model-tiers/model-tiers.ts (--write-defaults).",
    `# Generated at: ${meta.generatedAt}`,
    `# Artificial Analysis data: ${meta.dataTimestamp ?? "unknown (no timestamp in source)"} (${meta.dataKind})`,
    `# Regenerate with: ${meta.command}`,
    "#",
    "# One ordered failover chain per tier, cheapest-and-goodest first, in the",
    "# harness:model style of the team-lead routing section: pi:<provider>/<model>[:<thinking>],",
    "# claude:<model> for Claude Code models.",
    "",
  ]
  for (const chain of chains) {
    lines.push(`# ${chain.tier}: ${chain.rule}, ${chain.floor}`)
    lines.push(`${chain.tier}:`)
    if (chain.entries.length === 0) {
      lines.push("  []")
    } else {
      for (const entry of chain.entries) {
        const harness = meta.harnesses?.[entry.provider]
        lines.push(harness ? `  - ${harness}:${entry.modelId}` : `  - pi:${entry.piId}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n").replace(/\n+$/, "\n")
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface Args {
  offline?: string
  refresh: boolean
  json: boolean
  pinball?: string
  writeDefaults?: string | null
  config: string
  piList?: string
  help: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { refresh: false, json: false, config: DEFAULT_CONFIG_PATH, help: false, writeDefaults: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case "--offline": args.offline = next(); break
      case "--refresh": args.refresh = true; break
      case "--json": args.json = true; break
      case "--pinball": args.pinball = next(); break
      case "--write-defaults": {
        const value = argv[i + 1]
        args.writeDefaults = value && !value.startsWith("--") ? next() : null
        break
      }
      case "--config": args.config = resolve(next()); break
      case "--pi-list": args.piList = next(); break
      case "--help": case "-h": args.help = true; break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    const source = readFileSync(new URL(import.meta.url).pathname, "utf8")
    const header = source.slice(source.indexOf("/**") + 3, source.indexOf("*/"))
    console.log(
      header
        .split("\n")
        .map((line) => line.replace(/^ \* ?/, ""))
        .join("\n")
        .trim(),
    )
    return
  }

  const config = loadConfig(args.config)
  const dataset = await loadAADataset(config, { offline: args.offline, refresh: args.refresh })
  const piModels = [...(await loadPiModels(args.piList)), ...(config.extraModels ?? [])]
  const models = injectAbsentModels(dataset.models, config)
  const { candidates, unmapped, blocked } = buildCandidates(models, piModels, config)
  const { free, warnings: freeWarnings } = resolveFreeModels(config, piModels)
  const { pinned, warnings: pinnedWarnings } = resolvePinned(config, piModels, candidates)
  const { chains, warnings: tierWarnings } = buildTiers(candidates, config, free, pinned)
  const orderWarnings = [...tierWarnings, ...rankingWarnings(chains, config)]

  const meta = {
    dataKind: dataset.kind,
    dataTimestamp: dataset.timestamp,
    models: dataset.models.length,
    piModels: piModels.length,
    candidates: candidates.length,
    unmapped: unmapped.length,
    unmappedModels: unmapped,
    blockedModels: blocked,
    warnings: [...dataset.warnings, ...freeWarnings, ...pinnedWarnings, ...orderWarnings],
    providerStatus: config.providerStatus,
  }

  if (args.pinball) {
    const chain = chains.find((c) => c.tier === args.pinball)
    if (!chain) {
      throw new Error(
        `unknown tier "${args.pinball}"; known tiers: ${chains.map((c) => c.tier).join(", ")}`,
      )
    }
    console.log(JSON.stringify(formatPinball(chain, new Set(Object.keys(config.harnesses ?? {}))), null, 2))
    return
  }

  if (args.json) {
    console.log(JSON.stringify(formatJson(chains, meta), null, 2))
    return
  }

  if (args.writeDefaults !== undefined) {
    const target = args.writeDefaults
      ? resolve(args.writeDefaults)
      : DEFAULT_OUTPUT_PATH
    const yaml = renderDefaultsYaml(chains, {
      generatedAt: new Date().toISOString(),
      dataTimestamp: dataset.timestamp,
      dataKind: dataset.kind,
      command: "bun --env-file ~/work/.env tools/model-tiers/model-tiers.ts --write-defaults",
      harnesses: config.harnesses,
    })
    if (!existsSync(dirname(target))) throw new Error(`no such directory: ${dirname(target)}`)
    await Bun.write(target, yaml)
    console.log(`wrote ${target}`)
    return
  }

  console.log(formatTable(chains, meta))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`model-tiers: ${(error as Error).message}`)
    process.exit(1)
  })
}
