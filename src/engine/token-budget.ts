/**
 * DiffEngine context budgeting (FR-31/FR-32, R-TRUNC/FR-19).
 *
 * ```
 * OUTPUT_RESERVE_SOFT = max(max_output_tokens, 1500)
 * OUTPUT_RESERVE_HARD = max(max_output_tokens, 1000)
 *
 * available = context_window
 *           - estimate(system_prompt)
 *           - estimate(path_instructions + context_files)
 *           - OUTPUT_RESERVE_SOFT
 * ```
 *
 * `available` (computed with the *soft* reserve) is the packing target used
 * for every batch — the soft reserve is deliberately more generous
 * (subtracts more) than the hard one, so packing under `available` always
 * leaves at least `OUTPUT_RESERVE_HARD` tokens of headroom even in the worst
 * case (T4.9): an implementation that instead packed against the hard-reserve
 * budget would fit *more* input per batch and leave the model less room to
 * answer, which is exactly the bug this two-reserve scheme exists to avoid.
 *
 * Priority order among files (reused conceptually from
 * `github/select-files.ts`'s prioritization — this module only re-applies
 * rule 1, since `select-files.ts` already sorted the files this engine
 * receives by the rest of that ordering before this stage ever runs):
 *   1. Files matched by `review.path_instructions`.
 *   2. Original (incoming) order otherwise.
 *
 * Packing: files are greedily added to the current batch while they fit
 * under `available`; when a file doesn't fit the current batch, a new batch
 * is opened as long as the total stays within `max_model_calls`
 * (`K = min(ceil(need/available), max_model_calls)` — greedy bin-packing
 * reaches the same practical outcome — at most `max_model_calls` batches,
 * priority-ordered content first — without needing to precompute `K`
 * up front). Once `max_model_calls` batches are
 * full, every remaining file goes to `skipped` (R-TRUNC). A single file
 * whose own size exceeds `available` can never fit any batch and is skipped
 * immediately (T4.7) instead of stalling the packing loop.
 */

import { matchPathInstructions } from '../config/globs.ts'
import type { PathInstruction } from '../config/schema.ts'
import { renderFile } from '../github/diff-render.ts'
import type { DiffFile, SkippedFile } from '../github/diff-parse.ts'
import { estimateTokens } from '../provider/token-estimate.ts'

export const OUTPUT_RESERVE_SOFT_FLOOR = 1500
export const OUTPUT_RESERVE_HARD_FLOOR = 1000

export function outputReserveSoft (maxOutputTokens: number): number {
  return Math.max(maxOutputTokens, OUTPUT_RESERVE_SOFT_FLOOR)
}

export function outputReserveHard (maxOutputTokens: number): number {
  return Math.max(maxOutputTokens, OUTPUT_RESERVE_HARD_FLOOR)
}

export interface ComputeAvailableBudgetParams {
  contextWindow: number
  systemPromptTokens: number
  fixedContextTokens: number
  maxOutputTokens: number
}

/** The §7.4 `available` formula, computed with `OUTPUT_RESERVE_SOFT`. Never negative. */
export function computeAvailableBudget (params: ComputeAvailableBudgetParams): number {
  const reserve = outputReserveSoft(params.maxOutputTokens)
  const available =
    params.contextWindow - params.systemPromptTokens - params.fixedContextTokens - reserve
  return Math.max(0, available)
}

export interface TokenBudgetParams {
  /** Already filtered/prioritized by `select-files.ts`; this module only
   * re-applies the path_instructions priority rule on top. */
  files: readonly DiffFile[]
  contextWindow: number
  maxOutputTokens: number
  maxModelCalls: number
  contextLines: number
  /** `estimate(system_prompt)` — precomputed by the caller (`diff-engine.ts`),
   * which already has the built system prompt text at hand. */
  systemPromptTokens: number
  /** `estimate(path_instructions + context_files)` — precomputed by the
   * caller for the same reason. */
  fixedContextTokens: number
  pathInstructions: readonly PathInstruction[]
}

export interface TokenBudgetPlan {
  /** The per-batch packing target (§7.4 `available`, soft reserve). Exposed
   * mainly for tests (T4.2/T4.3) — `diff-engine.ts` itself only needs `batches`/`skipped`. */
  available: number
  batches: DiffFile[][]
  skipped: SkippedFile[]
  truncated: boolean
}

interface FileWithMeta {
  file: DiffFile
  index: number
  size: number
  pathInstructionRank: 0 | 1
}

export function planBatches (params: TokenBudgetParams): TokenBudgetPlan {
  const available = computeAvailableBudget({
    contextWindow: params.contextWindow,
    systemPromptTokens: params.systemPromptTokens,
    fixedContextTokens: params.fixedContextTokens,
    maxOutputTokens: params.maxOutputTokens
  })

  const withMeta: FileWithMeta[] = params.files.map((file, index) => ({
    file,
    index,
    size: estimateTokens(renderFile(file, params.contextLines)),
    pathInstructionRank:
      matchPathInstructions(file.path, params.pathInstructions).length > 0 ? 0 : 1
  }))

  withMeta.sort((a, b) => {
    if (a.pathInstructionRank !== b.pathInstructionRank) {
      return a.pathInstructionRank - b.pathInstructionRank
    }
    return a.index - b.index // stable tiebreak, matches select-files.ts convention
  })

  const batches: DiffFile[][] = []
  const skipped: SkippedFile[] = []
  let current: DiffFile[] = []
  let currentTokens = 0
  /** Once set, every remaining file (regardless of size) is skipped for this reason. */
  let limitReason: string | null = null

  for (const entry of withMeta) {
    if (limitReason !== null) {
      skipped.push({ path: entry.file.path, reason: limitReason })
      continue
    }

    if (entry.size > available) {
      // Can never fit any batch on its own (T4.7) — skip without touching
      // the current batch or opening a new one.
      skipped.push({ path: entry.file.path, reason: 'exceeds_token_budget' })
      continue
    }

    if (current.length > 0 && currentTokens + entry.size > available) {
      // Current batch is full. Opening a new batch is only allowed while
      // the total stays within max_model_calls.
      if (batches.length + 1 >= params.maxModelCalls) {
        batches.push(current)
        current = []
        currentTokens = 0
        limitReason = 'max_model_calls'
        skipped.push({ path: entry.file.path, reason: limitReason })
        continue
      }
      batches.push(current)
      current = []
      currentTokens = 0
    }

    current.push(entry.file)
    currentTokens += entry.size
  }

  if (current.length > 0) batches.push(current)

  return { available, batches, skipped, truncated: skipped.length > 0 }
}
