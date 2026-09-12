/**
 * `DiffEngine` (FR-30..FR-37): the first working review engine — turns an
 * already-selected diff into `Finding[]` by calling the provider once per
 * token-budget batch (`token-budget.ts`) with a system + user prompt
 * (`prompt/system.ts` + `prompt/diff-user.ts`) and a strict JSON schema
 * (FR-33), then validating/normalizing the model's findings
 * (`report/findings.ts`, FR-34).
 */

import type { PathInstruction } from '../config/schema.ts'
import { logger, debugLog, truncateForLog } from '../util/logger.ts'
import { ProviderError } from '../util/errors.ts'
import { extractJson } from '../provider/structured-output.ts'
import { estimateTokens } from '../provider/token-estimate.ts'
import { estimateCost, isBudgetTrackable, toPricing } from '../report/cost.ts'
import type { TokenUsage } from '../provider/types.ts'
import type { DiffFile } from '../github/diff-parse.ts'
import { normalizeFindings } from '../report/findings.ts'
import { planBatches } from './token-budget.ts'
import { buildSystemPrompt, FINDINGS_RESPONSE_SCHEMA } from './prompt/system.ts'
import {
  buildDiffUserPrompt,
  loadContextText,
  type DiffUserPromptContext
} from './prompt/diff-user.ts'
import type { Finding, ReviewContext, ReviewEngine, ReviewResult } from './types.ts'

/** `estimate(path_instructions + context_files)` — the §7.4 "fixed" term,
 * reserved once for the whole review (every batch reuses the same context
 * text, see `review()` below), not recomputed per batch. */
function estimateFixedContextTokens (
  pathInstructions: readonly PathInstruction[],
  contextText: string
): number {
  const instructionsText = pathInstructions
    .map((instruction) => instruction.instructions)
    .join('\n')
  return estimateTokens(`${instructionsText}\n${contextText}`)
}

function defaultSummary (findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No issues found.'
  return `Found ${findings.length} issue(s) across the reviewed files.`
}

interface BatchOutcome {
  findings: Finding[]
  summary: string
  usage: TokenUsage
}

export class DiffEngine implements ReviewEngine {
  readonly name = 'diff' as const

  async review (ctx: ReviewContext): Promise<ReviewResult> {
    const { config } = ctx
    const files = ctx.target.files
    const selectionSkipped = ctx.target.skipped

    // Schema description is only embedded in the *prompt text* at the third
    // FR-21 degradation rung; the schema estimate itself uses the common
    // (non-degraded) system prompt, which is what every batch actually sends
    // as `responseSchema` alongside `system`.
    const systemPrompt = buildSystemPrompt(config)
    const systemPromptTokens = estimateTokens(systemPrompt)

    const context = await loadContextText({
      files,
      always: config.context.always,
      layers: config.context.layers,
      maxContextBytes: config.context.max_context_bytes
    })

    const fixedContextTokens = estimateFixedContextTokens(
      config.review.path_instructions,
      context.text
    )

    const plan = planBatches({
      files,
      contextWindow: config.api.context_window,
      maxOutputTokens: config.review.max_output_tokens,
      maxModelCalls: config.review.max_model_calls,
      contextLines: config.filters.context_lines,
      systemPromptTokens,
      fixedContextTokens,
      pathInstructions: config.review.path_instructions
    })

    debugLog(
      config.debug,
      `diff-engine: planned ${plan.batches.length} batch(es) for ${files.length} file(s) ` +
        `(system prompt ~${systemPromptTokens} tokens, fixed context ~${fixedContextTokens} tokens)`
    )

    const notes: string[] = []
    if (selectionSkipped.length > 0) {
      notes.push(
        `${selectionSkipped.length} file(s) were not included in the review scope (select-files limits): ` +
          selectionSkipped.map((s) => s.path).join(', ')
      )
    }
    if (plan.skipped.length > 0) {
      notes.push(
        `${plan.skipped.length} file(s) could not be reviewed due to the model context budget: ` +
          plan.skipped.map((s) => s.path).join(', ')
      )
    }
    const truncated = selectionSkipped.length > 0 || plan.skipped.length > 0

    const findings: Finding[] = []
    const summaries: string[] = []
    let promptTokens = 0
    let completionTokens = 0
    let anyEstimated = false
    let attempted = 0
    let succeeded = 0
    // costUsd is only meaningful as a total when EVERY call reported one —
    // a single missing value makes the sum misleading, so one `undefined`
    // poisons the whole aggregate rather than being silently skipped.
    let costUsd = 0
    let everyCallHadCost = true

    // T8.6 (THR-8/R-13): the same hard cost cutoff as `AgentEngine`'s, applied between batches —
    // `budget.max_cost_usd` is "independent of mode" (PRD §12.5). Estimate-based only; see `cost.ts`.
    const budgetPricing = toPricing(config.budget.pricing)
    const budgetTrackable = isBudgetTrackable(config.budget.max_cost_usd, budgetPricing, (m) =>
      logger.warning(m)
    )

    for (const batch of plan.batches) {
      if (ctx.signal.aborted) {
        notes.push(
          'Review stopped early: the overall run timeout was reached before every batch could be processed.'
        )
        break
      }
      if (budgetTrackable) {
        const costSoFar = Number(estimateCost({ promptTokens, completionTokens }, budgetPricing!))
        if (costSoFar >= config.budget.max_cost_usd!) {
          notes.push(
            `Review stopped: reached the cost budget ($${config.budget.max_cost_usd}) before every batch could be processed.`
          )
          break
        }
      }

      attempted++
      try {
        const outcome = await this.reviewBatch(batch, ctx, systemPrompt, context)
        findings.push(...outcome.findings)
        if (outcome.summary !== '') summaries.push(outcome.summary)
        promptTokens += outcome.usage.promptTokens
        completionTokens += outcome.usage.completionTokens
        anyEstimated = anyEstimated || outcome.usage.estimated
        if (outcome.usage.costUsd !== undefined) {
          costUsd += outcome.usage.costUsd
        } else {
          everyCallHadCost = false
        }
        succeeded++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const batchPaths = batch.map((f) => f.path).join(', ')
        notes.push(
          `A batch of ${batch.length} file(s) (${batchPaths}) failed after retries: ${message}`
        )
        logger.warning(`diff-engine: batch failed (${batchPaths}): ${message}`)
      }
    }

    if (attempted > 0 && succeeded === 0) {
      throw new ProviderError(
        `All ${attempted} review batch(es) failed; no findings could be produced.`,
        'Check provider connectivity/credentials and see the logged warnings above for per-batch errors.'
      )
    }

    const aggregatedCostUsd = succeeded > 0 && everyCallHadCost ? costUsd : undefined

    return {
      summary: summaries.length > 0 ? summaries.join('\n\n') : defaultSummary(findings),
      findings,
      usage: {
        promptTokens,
        completionTokens,
        estimated: anyEstimated,
        ...(aggregatedCostUsd !== undefined ? { costUsd: aggregatedCostUsd } : {})
      },
      notes,
      truncated,
      findingsFiltered: 0
    }
  }

  private async reviewBatch (
    batchFiles: DiffFile[],
    ctx: ReviewContext,
    systemPrompt: string,
    context: DiffUserPromptContext
  ): Promise<BatchOutcome> {
    const { config } = ctx

    const userPrompt = buildDiffUserPrompt({
      files: batchFiles,
      contextLines: config.filters.context_lines,
      prTitle: ctx.pr.title,
      prBody: ctx.pr.body ?? '',
      pathInstructions: config.review.path_instructions,
      context
    })

    const batchLabel = batchFiles.map((f) => f.path).join(', ')
    debugLog(config.debug, `diff-engine: batch [${batchLabel}] — sending prompt: ${truncateForLog(userPrompt)}`)

    const response = await ctx.provider.complete({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      responseSchema: FINDINGS_RESPONSE_SCHEMA,
      maxOutputTokens: config.review.max_output_tokens,
      signal: ctx.signal
    })

    debugLog(
      config.debug,
      `diff-engine: batch [${batchLabel}] response — finishReason=${response.finishReason}, ` +
        `usage={prompt:${response.usage.promptTokens},completion:${response.usage.completionTokens}}, ` +
        `text=${truncateForLog(response.text ?? '(null)')}`
    )

    let parsed: unknown = {}
    if (response.text !== null) {
      try {
        parsed = extractJson(response.text)
      } catch {
        // Defensive fallback only: `ctx.provider.complete()` (via
        // structured-output.ts's ladder) already guarantees parsable JSON
        // for a successful response. Treated as "no usable findings" rather
        // than failing the whole batch.
        logger.warning(
          'diff-engine: response text was not valid JSON despite a successful completion'
        )
      }
    }

    const obj =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
    const validPaths = new Set(batchFiles.map((f) => f.path))

    const findings = normalizeFindings(rawFindings, validPaths, {
      onWarning: (message) => logger.warning(`diff-engine: ${message}`),
      onDrop: (reason) => logger.warning(`diff-engine: dropped finding — ${reason}`)
    })

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''

    return { findings, summary, usage: response.usage }
  }
}
