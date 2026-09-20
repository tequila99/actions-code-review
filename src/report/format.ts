/**
 * Renders the human-facing summaries (FR-71): a single sticky-comment
 * *history entry* (`formatReviewEntry`) and the job summary
 * (`formatJobSummary`, consumed by `main.ts` via
 * `core.summary.addRaw(...).write()` — this module deliberately returns a
 * plain string rather than touching `@actions/core` itself, so it stays a
 * pure function that's trivial to test).
 *
 * The sticky PR comment accumulates a capped history of run entries instead
 * of being fully overwritten every run. This module only builds the
 * markdown for a *single* entry, already wrapped in its own
 * `ENTRY_START`/`ENTRY_END` delimiters; everything about the top-level
 * `STICKY_MARKER`, concatenating entries into history, capping to
 * `STICKY_HISTORY_MAX_ENTRIES`, and the machine-readable state block lives
 * entirely in `github/sticky-comment.ts` (`buildStickyBody`). This module
 * intentionally does NOT import from `github/sticky-comment.ts` (that
 * import used to run the other way, before this history feature existed) —
 * it has no knowledge of history/top-level-marker concerns at all.
 */

import type { SkippedFile } from '../github/diff-parse.ts'
import type { Finding } from '../engine/types.ts'
import type { SeverityMax } from './severity.ts'

/** Escapes markdown table-breaking characters (T5.45): pipes and raw newlines. */
export function escapeMarkdown (text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Delimiters wrapping a single history entry inside the sticky comment
 * body. Neither string contains regex metacharacters, so
 * `github/sticky-comment.ts` can embed them directly into a `RegExp`
 * without escaping.
 */
export const ENTRY_START = '<!-- actions-code-review:entry -->'
export const ENTRY_END = '<!-- /actions-code-review:entry -->'

export interface FormatSummaryParams {
  /** Findings actually posted inline (or that would be, under dry_run). */
  postedFindings: readonly Finding[]
  /** Findings only described in text: invalid position, summary_only, overflow, or 422 fallback. */
  unpostedFindings: readonly Finding[]
  notes: readonly string[]
  truncated: boolean
  skippedFiles: readonly SkippedFile[]
  tokensInput: number
  tokensOutput: number
  mode: string
  model: string
  costEstimateUsd: string
  filesReviewed: number
  severityMax: SeverityMax
  /** FR-53: findings dropped by the noise-filter pass (0 unless `mode: agent`
   * ran with `agent.filter_model` configured). */
  findingsFiltered: number
}

/**
 * Params for a single history entry: everything
 * `FormatSummaryParams` already had, plus the identity of this particular
 * run — the GitHub review id (`null` under dry_run/when publishing failed
 * to produce one) and the ISO timestamp the run started at.
 */
export interface FormatReviewEntryParams extends FormatSummaryParams {
  reviewId: number | null
  startedAt: string
}

function findingLine (finding: Finding): string {
  const range =
    finding.endLine && finding.endLine !== finding.line
      ? `${finding.line}-${finding.endLine}`
      : `${finding.line}`
  const base = `- \`${escapeMarkdown(finding.path)}:${range}\` **${finding.severity}** — ${escapeMarkdown(finding.message)}`
  // finding.suggestion is literal code (FR-51) — deliberately not run through
  // escapeMarkdown, which collapses newlines and would corrupt a multi-line replacement.
  if (finding.suggestion === undefined) return base
  const indented = finding.suggestion
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
  return `${base}\n\n  \`\`\`suggestion\n${indented}\n  \`\`\``
}

/**
 * Builds the markdown for a single sticky-comment history entry, already
 * wrapped in `ENTRY_START`/`ENTRY_END` delimiters. The header
 * is `### Review #<reviewId> — <startedAt>`; `reviewId: null` (dry_run, or
 * publish didn't produce one) renders as `### Review #— — <startedAt>` (an
 * em dash placeholder, documented here as the single source of truth for
 * that formatting choice).
 */
export function formatReviewEntry (params: FormatReviewEntryParams): string {
  const totalFindings = params.postedFindings.length + params.unpostedFindings.length
  const reviewIdLabel = params.reviewId ?? '—'
  const lines: string[] = [
    ENTRY_START,
    '',
    `### Review #${reviewIdLabel} — ${params.startedAt}`,
    ''
  ]

  lines.push(
    `- **Mode:** ${params.mode}`,
    `- **Model:** ${params.model}`,
    `- **Files reviewed:** ${params.filesReviewed}`,
    `- **Findings:** ${totalFindings} (posted inline: ${params.postedFindings.length})`,
    `- **Max severity:** ${params.severityMax}`,
    `- **Tokens:** in ${params.tokensInput} / out ${params.tokensOutput}`,
    `- **Estimated cost (USD):** ${params.costEstimateUsd || 'n/a'}`
  )

  // Only shown when the noise filter actually dropped something — most runs
  // don't have `agent.filter_model` configured at all, so an always-"0" line would just be noise.
  if (params.findingsFiltered > 0) {
    lines.push(`- **Findings filtered (noise):** ${params.findingsFiltered}`)
  }

  if (params.truncated) {
    lines.push('', '### Not reviewed')
    if (params.skippedFiles.length > 0) {
      for (const f of params.skippedFiles) {
        lines.push(`- \`${escapeMarkdown(f.path)}\` — ${escapeMarkdown(f.reason)}`)
      }
    } else {
      lines.push('- Some changes were not reviewed due to size/budget limits (see notes below).')
    }
  }

  if (params.unpostedFindings.length > 0) {
    lines.push('', '### Findings not posted inline')
    for (const finding of params.unpostedFindings) {
      lines.push(findingLine(finding))
    }
  }

  if (params.notes.length > 0) {
    lines.push('', '### Notes')
    for (const note of params.notes) {
      lines.push(`- ${escapeMarkdown(note)}`)
    }
  }

  lines.push('', ENTRY_END)

  return lines.join('\n')
}

function formatLocation (finding: Finding): string {
  return finding.endLine && finding.endLine !== finding.line
    ? `${finding.path}:${finding.line}-${finding.endLine}`
    : `${finding.path}:${finding.line}`
}

/**
 * Plain-text listing of every finding for a `dry_run` log (issue #12): a dry
 * run publishes nothing, so this is the only place the full messages can be
 * read without a Job Summary (which local runs don't have). Messages are
 * printed unclipped — the whole point is to judge the review's quality.
 */
export function formatDryRunFindings (posted: Finding[], unposted: Finding[]): string {
  if (posted.length === 0 && unposted.length === 0) return 'No findings.'

  const section = (title: string, findings: Finding[]): string[] =>
    findings.length === 0
      ? []
      : [
          `${title} (${findings.length}):`,
          ...findings.flatMap((f) => [
            '',
            `[${f.severity}/${f.category}] ${formatLocation(f)}`,
            f.message,
            ...(f.suggestion !== undefined ? ['Suggested replacement:', f.suggestion] : [])
          ]),
          ''
        ]

  return [
    ...section('Would post inline', posted),
    ...section('Summary only', unposted)
  ]
    .join('\n')
    .trimEnd()
}

/**
 * Builds the Job Summary markdown (FR-71, T5.44): a pipe-table of every
 * finding (posted + unposted) plus the same headline metrics.
 */
export function formatJobSummary (params: FormatSummaryParams): string {
  const allFindings = [...params.postedFindings, ...params.unpostedFindings]
  const lines: string[] = ['## AI Code Review', '']

  lines.push(
    `- **Mode:** ${params.mode}`,
    `- **Model:** ${params.model}`,
    `- **Files reviewed:** ${params.filesReviewed}`,
    `- **Findings:** ${allFindings.length}`,
    `- **Max severity:** ${params.severityMax}`,
    `- **Tokens:** in ${params.tokensInput} / out ${params.tokensOutput}`,
    `- **Estimated cost (USD):** ${params.costEstimateUsd || 'n/a'}`
  )

  if (params.findingsFiltered > 0) {
    lines.push(`- **Findings filtered (noise):** ${params.findingsFiltered}`)
  }

  if (allFindings.length > 0) {
    lines.push('', '| Severity | Path | Line | Message |', '|---|---|---|---|')
    for (const finding of allFindings) {
      const range =
        finding.endLine && finding.endLine !== finding.line
          ? `${finding.line}-${finding.endLine}`
          : `${finding.line}`
      lines.push(
        `| ${escapeMarkdown(finding.severity)} | ${escapeMarkdown(finding.path)} | ${range} | ${escapeMarkdown(finding.message)} |`
      )
    }
  }

  return lines.join('\n')
}
