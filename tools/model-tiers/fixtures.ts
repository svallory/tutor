/**
 * Small hand-built fixtures for tools/model-tiers tests. Deliberately tiny and
 * synthetic so each test states exactly the numbers it depends on.
 */

import type { Config, PiModel } from "./model-tiers.ts"

export function pi(provider: string, id: string, opts: Partial<PiModel> = {}): PiModel {
  return {
    provider,
    id,
    contextTokens: 200_000,
    maxOutputTokens: 65_500,
    thinking: true,
    images: false,
    ...opts,
  }
}

export interface RowOptions {
  coding?: number | null
  intelligence?: number | null
  agentic?: number | null
  softwareEngineering?: number | null
  costPerTask?: number | null
  blended?: number | null
  input?: number | null
  output?: number | null
  tps?: number | null
  endToEnd?: number | null
  outputTokens?: number | null
  contextWindow?: number | null
}

/** A raw Artificial Analysis row, shaped like the live/free API payload. */
export function aaRow(name: string, slug: string, opts: RowOptions = {}): Record<string, unknown> {
  const {
    coding = null,
    intelligence = null,
    agentic = null,
    softwareEngineering = null,
    costPerTask = null,
    blended = null,
    input = null,
    output = null,
    tps = null,
    endToEnd = null,
    outputTokens = null,
    contextWindow = null,
  } = opts

  const row: Record<string, unknown> = {
    id: `id-${slug}`,
    name,
    slug,
    release_date: "2026-09-01",
    model_creator: { id: "c", name: "Testco", slug: "testco" },
    evaluations: {
      artificial_analysis_coding_index: coding,
      artificial_analysis_intelligence_index: intelligence,
      artificial_analysis_agentic_index: agentic,
    },
    pricing: {
      price_1m_blended_3_to_1: blended,
      price_1m_input_tokens: input,
      price_1m_output_tokens: output,
    },
    performance: {
      median_output_tokens_per_second: tps,
      median_end_to_end_response_time_seconds: endToEnd,
    },
  }
  if (softwareEngineering != null) {
    ;(row.evaluations as Record<string, unknown>).software_engineering = softwareEngineering
  }
  if (costPerTask != null) {
    row.artificial_analysis_intelligence_index_cost = {
      total_cost: costPerTask * 100,
      cost_per_task: { total_cost: costPerTask },
    }
  }
  if (outputTokens != null) {
    row.artificial_analysis_intelligence_index_token_counts = {
      input_tokens: 1000,
      answer_tokens: outputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: 0,
    }
  }
  if (contextWindow != null) row.context_window_tokens = contextWindow
  return row
}

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    api: {
      baseUrl: "https://artificialanalysis.ai/api/v2",
      fullPath: "/language/models",
      freePath: "/language/models/free",
      cacheDir: "/tmp/model-tiers-test-cache",
      cacheTtlHours: 12,
    },
    capability: { weights: { coding: 0.6, intelligence: 0.4 } },
    cost: { subscriptionWeight: 0.25, defaultBilling: "metered", providers: {} },
    blocked: [],
    quota: { tiers: {} },
    chainLength: 5,
    diversity: { minProviders: 2 },
    escalation: { allow: false, scope: "model" },
    research: { minContextTokens: 200_000, prefer: [] },
    tiers: {
      cto: { minCapabilityRatio: 0.97, rankBy: ["capability"], thinking: "high" },
      lead: { minCapabilityRatio: 0.92, rankBy: ["capability", "cost"], thinking: "high" },
      senior: { minCapabilityRatio: 0.85, rankBy: ["capabilityPerCost"], thinking: "high" },
      dev: { minCapabilityRatio: 0.75, rankBy: ["capabilityPerCost", "speed"], thinking: "medium" },
      intern: { minCapabilityRatio: 0.55, rankBy: ["cost", "speed"], thinking: "low" },
      research: { axis: "context-cost", rankBy: ["cost", "speed"], thinking: "off" },
    },
    aliases: {},
    ...overrides,
  }
}

export const PI_LIST_DUMP = `provider      model                                     context  max-out  thinking  images
google        gemini-3.8-flash                          1.0M     65.5K    yes       yes
openai-codex  gpt-6-sol                                272K     128K     yes       no
opencode-go   kimi-k3                                  1.0M     131.1K   yes       yes
groq          openai/gpt-oss-120b                      131.1K   65.5K    yes       no
huggingface   moonshotai/Kimi-K2-Thinking              262.1K   262.1K   yes       no
`
