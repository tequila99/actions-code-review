/**
 * Severity-driven decisions on the finalized finding set (FR-66/FR-67):
 * the overall max severity, whether the run should fail, and the single
 * point in the whole project where `max_comments` is enforced (FR-66 says
 * this literally — engines never truncate their own output).
 */

import type { Finding } from '../engine/types.ts'

export type SeverityMax = Finding['severity'] | 'none'

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3
}

/** Highest severity present, or `'none'` for an empty finding list (T5.30). */
export function severityMax (findings: readonly Finding[]): SeverityMax {
  let best: SeverityMax = 'none'
  let bestRank = Infinity
  for (const finding of findings) {
    const rank = SEVERITY_RANK[finding.severity]
    if (rank < bestRank) {
      bestRank = rank
      best = finding.severity
    }
  }
  return best
}

/**
 * FR-67: `'none'` never fails; `'high'` fails only when a `high` finding is
 * present; `'medium'` fails on `medium` OR `high` (T5.26-T5.29). Split out
 * from `shouldFail` so a caller that already has a `SeverityMax` (e.g.
 * `main.ts`'s already-built outputs) doesn't need to re-walk the finding
 * array just to answer the same question.
 */
export function shouldFailFromMax (
  max: SeverityMax,
  failOnSeverity: 'none' | 'medium' | 'high'
): boolean {
  if (failOnSeverity === 'none') return false
  if (max === 'none') return false
  if (failOnSeverity === 'high') return max === 'high'
  // failOnSeverity === 'medium'
  return max === 'high' || max === 'medium'
}

export function shouldFail (
  findings: readonly Finding[],
  failOnSeverity: 'none' | 'medium' | 'high'
): boolean {
  return shouldFailFromMax(severityMax(findings), failOnSeverity)
}

export interface SortAndTruncateResult {
  kept: Finding[]
  overflow: Finding[]
}

/**
 * Sorts `findings` high -> medium -> low -> info, tie-broken by `path` then
 * `line` (T5.31), then truncates to `maxComments` (T5.32) — the single
 * truncation point for the whole project (FR-66). The most severe findings
 * are kept; anything past the limit is returned separately as `overflow` so
 * callers can still mention it in the summary text.
 */
export function sortAndTruncate (
  findings: readonly Finding[],
  maxComments: number
): SortAndTruncateResult {
  const sorted = [...findings].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (rankDiff !== 0) return rankDiff
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.line - b.line
  })
  return { kept: sorted.slice(0, maxComments), overflow: sorted.slice(maxComments) }
}
