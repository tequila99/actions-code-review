/**
 * Дополнение G (FR-53): noise filtering via a cheap second model, `mode:
 * agent` only. After the tool loop ends, the collected findings are shown
 * to `ctx.filterProvider` (same provider/api_key/base_url as the main
 * review, a different — cheaper — `model`, see `provider/factory.ts`) and
 * it decides which are worth keeping. Off by default (`agent.filter_model:
 * ''`); `AgentEngine` only calls this when `ctx.filterProvider` is set.
 *
 * Fails open, deliberately: a network error, a malformed response, or an
 * empty completion all fall back to "keep every finding" rather than
 * risking a bug here silently discarding real findings. The cost of
 * failing open is at most "the filter pass didn't run this time" — the
 * cost of failing closed would be losing real review findings to a bug in
 * a supplementary feature.
 */

import { logger } from '../util/logger.ts'
import { extractJson } from '../provider/structured-output.ts'
import type { ProviderAdapter, JsonSchema } from '../provider/types.ts'
import type { Finding } from './types.ts'

/** A fixed, small budget — the response is just an array of integers, not prose; no need for
 * `review.max_output_tokens`, which sizes the (much larger) main review response. */
export const NOISE_FILTER_MAX_OUTPUT_TOKENS = 500

const NOISE_FILTER_SYSTEM_PROMPT = [
  'You are a strict noise filter for code review comments, running as a second, cheaper pass',
  'after another model already reviewed a pull request and produced a numbered list of findings.',
  'Decide which findings are genuinely worth a developer\'s attention, and which are low-value',
  'noise: nitpicks with no real impact, findings that just restate what the code already says,',
  'speculative or low-confidence claims, or style preferences a linter would already catch.',
  'Respond with a single JSON object {"keep": number[]} listing the 0-based indices of the',
  'findings worth keeping. Nothing else.'
].join(' ')

const NOISE_FILTER_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    keep: {
      type: 'array',
      items: { type: 'integer' },
      description: '0-based indices of the findings worth keeping.'
    }
  },
  required: ['keep']
}

function buildUserPrompt (findings: readonly Finding[]): string {
  const lines = findings.map(
    (f, i) => `${i}. [${f.severity}/${f.category}] ${f.path}:${f.line} — ${f.message}`
  )
  return ['Findings:', '', ...lines].join('\n')
}

export interface NoiseFilterResult {
  kept: Finding[]
  filteredCount: number
  /** Set only when the pass itself failed (fail-open) — a success that keeps every finding
   * (nothing was noise) is not a failure and does not set this. */
  note?: string
}

export async function filterNoise (
  findings: readonly Finding[],
  provider: ProviderAdapter,
  signal: AbortSignal
): Promise<NoiseFilterResult> {
  if (findings.length === 0) return { kept: [], filteredCount: 0 }

  try {
    const response = await provider.complete({
      system: NOISE_FILTER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(findings) }],
      responseSchema: NOISE_FILTER_RESPONSE_SCHEMA,
      maxOutputTokens: NOISE_FILTER_MAX_OUTPUT_TOKENS,
      signal
    })
    if (response.text === null) {
      throw new Error('empty response')
    }
    const parsed = extractJson(response.text) as { keep?: unknown }
    if (!Array.isArray(parsed.keep)) {
      throw new Error('response JSON has no "keep" array')
    }
    const validIndices = new Set(
      parsed.keep.filter(
        (i): i is number =>
          typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < findings.length
      )
    )
    const kept = findings.filter((_, i) => validIndices.has(i))
    return { kept, filteredCount: findings.length - kept.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warning(`noise-filter: filter pass failed (${message}) — keeping all findings unfiltered.`)
    return {
      kept: [...findings],
      filteredCount: 0,
      note: 'The noise-filter pass (agent.filter_model) failed; all findings were kept unfiltered.'
    }
  }
}
