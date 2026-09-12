/**
 * Deduplication (FR-65, R-9): drops findings that duplicate another finding
 * in the same batch, and findings that duplicate an already-posted PR review
 * comment (read via `github/review.ts#listExistingReviewComments`, passed in
 * here rather than fetched by this module — this stays a pure function of
 * its inputs, no network access).
 */

import type { Finding } from '../engine/types.ts'

/** The minimal shape of an already-posted inline review comment this module needs. */
export interface ExistingReviewComment {
  path: string
  /** GitHub's `line` field: for multi-line comments, the *last* line of the range. */
  line: number | null
  body: string
}

/** trim + lowercase + collapse whitespace runs (T5.23). */
function normalizeText (text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function dedupeKey (path: string, line: number, message: string): string {
  return `${path} ${line} ${normalizeText(message)}`
}

/**
 * Removes findings that:
 * - duplicate an earlier finding (same path + line + normalized message,
 *   T5.21/T5.23), keeping the first occurrence in array order (T5.25);
 * - duplicate an already-posted PR review comment at the same (path, line)
 *   whose body contains the finding's normalized message (T5.24) — an
 *   `includes` check rather than exact equality, since a posted comment
 *   body wraps the raw finding message in extra formatting
 *   (`github/review.ts#formatCommentBody`). The comparison uses
 *   `finding.endLine ?? finding.line`: GitHub's review-comment `line` field
 *   always names the *end* of a multi-line range, not the start (TAA4), and
 *   that's exactly what `listExistingReviewComments` hands back here.
 */
export function dedupeFindings (
  findings: readonly Finding[],
  existingComments: readonly ExistingReviewComment[] = []
): Finding[] {
  const seen = new Set<string>()
  const result: Finding[] = []

  for (const finding of findings) {
    const key = dedupeKey(finding.path, finding.line, finding.message)
    if (seen.has(key)) continue

    const normalizedMessage = normalizeText(finding.message)
    const anchorLine = finding.endLine ?? finding.line
    const matchesExisting = existingComments.some(
      (comment) =>
        comment.path === finding.path &&
        comment.line === anchorLine &&
        normalizeText(comment.body).includes(normalizedMessage)
    )
    if (matchesExisting) continue

    seen.add(key)
    result.push(finding)
  }

  return result
}
