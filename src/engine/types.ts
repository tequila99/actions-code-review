/**
 * `ReviewEngine` contract (PRD §7.2, verbatim field names/shapes for
 * `ReviewResult`/`Finding`). Stage 4 implements the `'diff'` engine
 * (`diff-engine.ts`); `'agent'` is stage 7 (`agent-engine.ts`, not present
 * yet — see `selector.ts`).
 */

import type { ResolvedConfig } from '../config/schema.ts'
import type { DiffFile, SkippedFile } from '../github/diff-parse.ts'
import type { ProviderAdapter, TokenUsage } from '../provider/types.ts'

/**
 * The files this review run will look at, already filtered/prioritized by
 * `github/select-files.ts` (`SelectFilesResult` minus `truncated`/
 * `skippedReason`, which the caller folds into `notes`/logging itself before
 * building `ReviewContext`). `DiffEngine.review()` never calls `selectFiles`
 * itself (that responsibility stays with the future `main.ts` wiring).
 */
export interface ReviewTarget {
  files: DiffFile[]
  /** Files `select-files.ts` already excluded (limits, not filters) — carried
   * through so `DiffEngine` can report them in `ReviewResult.notes` (R-TRUNC). */
  skipped: SkippedFile[]
}

/**
 * The subset of a PR's own fields the prompt layer needs (title/description,
 * both untrusted — SEC-1/SEC-2). Deliberately a different shape (and name)
 * than `github/pull-request.ts`'s `PullRequestInfo`, which only carries
 * `draft`/`labels` for the FR-14/FR-15 skip check — that type has nothing to
 * do with prompt building and reusing its name here across two different
 * shapes in the same layer would be confusing (documented deviation from the
 * PRD's literal interface name, which reuses `PullRequestInfo` for both).
 */
export interface ReviewPullRequestInfo {
  number: number
  title: string
  body: string | null
}

export interface ReviewContext {
  config: ResolvedConfig
  provider: ProviderAdapter
  target: ReviewTarget
  pr: ReviewPullRequestInfo
  /** Overall run timeout (FR-23, `total_timeout_ms`). */
  signal: AbortSignal
  /** Дополнение G (FR-53): set only when `agent.filter_model` is configured — the same
   * provider/api_key/base_url as `provider`, just a different (cheaper) `model`. `AgentEngine`
   * only; `DiffEngine` ignores it entirely (decision: noise filtering is agent-mode-only). */
  filterProvider?: ProviderAdapter
}

export interface Finding {
  path: string
  /** Line in the new version of the file. */
  line: number
  endLine?: number
  severity: 'high' | 'medium' | 'low' | 'info'
  /** e.g. correctness | security | performance | style | architecture | ... */
  category: string
  message: string
  /** AgentEngine only (Дополнение D, FR-51) — a verified-against-disk literal
   * code replacement for lines [line, endLine ?? line], rendered as a
   * GitHub-native `suggestion` fence. Never set by DiffEngine (FR-69). */
  suggestion?: string
}

export interface ReviewResult {
  summary: string
  findings: Finding[]
  usage: TokenUsage
  /** e.g. "files not reviewed", "iteration limit exhausted". */
  notes: string[]
  truncated: boolean
  /** Дополнение G (FR-53): findings dropped by the noise-filter pass. Always `0` for
   * `DiffEngine` and for `AgentEngine` runs without `agent.filter_model` configured — never
   * `undefined`, so callers don't need an extra presence check to display it. */
  findingsFiltered: number
}

export interface ReviewEngine {
  readonly name: 'diff' | 'agent'
  review(ctx: ReviewContext): Promise<ReviewResult>
}
