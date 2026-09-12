/**
 * Publishes findings to a PR (FR-60..FR-62/FR-68/FR-69). This is
 * layer 2+3 of the three-layer 422 defense described in `position-map.ts`
 * (layer 1): here we build the `pulls.createReview` payload from
 * already-validated positions and, if GitHub still rejects the batch with a
 * 422, fall back to a summary-only publication instead of throwing (layer 3
 * — the caller, `main.ts`, always gets a usable result to build the sticky
 * comment from).
 */

import type { OctokitClient } from './context.ts'
import type { PositionMap } from './position-map.ts'
import type { Finding } from '../engine/types.ts'
import type { ExistingReviewComment } from '../report/dedupe.ts'
import { redact } from '../util/secrets.ts'
import { GithubApiError } from '../util/errors.ts'
import { logger } from '../util/logger.ts'

interface HttpErrorLike {
  status?: number
}

function statusOf (error: unknown): number | undefined {
  return typeof error === 'object' && error !== null ? (error as HttpErrorLike).status : undefined
}

/** The slice of an Octokit `RequestError` this module cares about: GitHub's
 * per-field validation detail for a rejected `createReview` call. */
interface RequestErrorLike {
  response?: {
    data?: {
      errors?: unknown[]
    }
  }
}

function errorDetailMessage (detail: unknown): string | null {
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object' && detail !== null && 'message' in detail) {
    const message = (detail as { message?: unknown }).message
    return typeof message === 'string' ? message : null
  }
  return null
}

/**
 * Best-effort extraction of which (path, line) GitHub blamed for a 422,
 * from Octokit's `RequestError.response.data.errors[]`. GitHub does not
 * document or guarantee this message format — this is a heuristic that
 * only recognizes a `path:line` substring (e.g. `src/a.ts:12`), same shape
 * as a `finding.path`/comment `line`. A bare `position` mention (GitHub's
 * other common wording) carries no path and can't be mapped back to a
 * specific comment, so it's deliberately left unrecognized rather than
 * guessed at.
 */
function extractBlamedPositions (error: unknown): Array<{ path: string; line: number }> {
  const errors = (error as RequestErrorLike).response?.data?.errors
  if (!Array.isArray(errors)) return []
  const blamed: Array<{ path: string; line: number }> = []
  for (const detail of errors) {
    const message = errorDetailMessage(detail)
    if (message === null) continue
    const match = /([^\s:]+\.\w+):(\d+)/.exec(message)
    if (match) blamed.push({ path: match[1]!, line: Number(match[2]) })
  }
  return blamed
}

/**
 * Builds the text body of one inline review comment: a severity/category
 * header, the (redacted) message, an optional literal code-suggestion
 * (FR-51 — AgentEngine only, already verified against disk before reaching
 * here), and a small-font `<sub>` footer naming the model that produced it —
 * set apart from the main text so it reads as metadata, not part of the
 * finding itself. Useful when comparing multiple models' review quality on
 * the same PR.
 */
export function formatCommentBody (finding: Finding, model: string): string {
  const parts = [
    `**${finding.severity.toUpperCase()}** (${finding.category})`,
    '',
    redact(finding.message)
  ]
  if (finding.suggestion !== undefined) {
    parts.push('', '```suggestion', redact(finding.suggestion), '```')
  }
  parts.push('', `<sub>🤖 ${model}</sub>`)
  return parts.join('\n')
}

interface ReviewComment {
  path: string
  body: string
  line: number
  side: 'RIGHT'
  start_line?: number
  start_side?: 'RIGHT'
}

/**
 * Validates one finding's position against `positionMap` (layer 1) and, if
 * valid, builds the GitHub review-comment payload for it. `finding.line` is
 * the *start* of a range and `finding.endLine` (when present) its end — the
 * inverse of GitHub's own `line`/`start_line` naming, where `line` anchors
 * the *end* of the range (T5.3/T5.4).
 */
function buildComment (
  finding: Finding,
  positionMap: PositionMap,
  model: string
): ReviewComment | null {
  if (finding.endLine !== undefined && finding.endLine !== finding.line) {
    const range = positionMap.validateRange(finding.path, finding.line, finding.endLine)
    if (range === null) return null
    if (range.startLine === range.endLine) {
      return {
        path: finding.path,
        body: formatCommentBody(finding, model),
        line: range.endLine,
        side: 'RIGHT'
      }
    }
    return {
      path: finding.path,
      body: formatCommentBody(finding, model),
      line: range.endLine,
      side: 'RIGHT',
      start_line: range.startLine,
      start_side: 'RIGHT'
    }
  }

  if (!positionMap.isValid(finding.path, finding.line)) return null
  return {
    path: finding.path,
    body: formatCommentBody(finding, model),
    line: finding.line,
    side: 'RIGHT'
  }
}

export interface PublishReviewParams {
  owner: string
  repo: string
  prNumber: number
  /** Named in each posted comment's `<sub>` footer (see `formatCommentBody`). */
  model: string
  findings: readonly Finding[]
  positionMap: PositionMap
  /** Top-level review body (separate from the sticky summary comment). */
  body?: string
  /** FR-68: skip every mutating call, still compute the position split. */
  dryRun: boolean
  /** T5.8: never send inline comments, everything goes to `unpostedFindings`. */
  summaryOnly?: boolean
}

export interface PublishReviewResult {
  reviewId: number | null
  /** Findings that were (or, under `dryRun`, would have been) posted inline. */
  postedFindings: Finding[]
  /** Findings that ended up text-only in the summary (invalid position, summary_only, or 422 fallback). */
  unpostedFindings: Finding[]
  /** True if `createReview` was attempted and rejected with 422 (layer 3 fallback taken). */
  fallbackToSummaryOnly: boolean
}

/**
 * Publishes `findings` as a single `pulls.createReview({event: 'COMMENT'})`
 * (FR-60). `createReview` is called at most once, and only when there is at
 * least one comment with a valid position (T5.1/T5.7/T5.11); `dryRun`
 * disables every mutating call while still returning the same
 * posted/unposted split the caller needs for its outputs (T5.9).
 */
export async function publishReview (
  client: OctokitClient,
  params: PublishReviewParams
): Promise<PublishReviewResult> {
  if (params.findings.length === 0) {
    return {
      reviewId: null,
      postedFindings: [],
      unpostedFindings: [],
      fallbackToSummaryOnly: false
    }
  }

  if (params.summaryOnly) {
    return {
      reviewId: null,
      postedFindings: [],
      unpostedFindings: [...params.findings],
      fallbackToSummaryOnly: false
    }
  }

  const valid: { finding: Finding; comment: ReviewComment }[] = []
  const invalid: Finding[] = []
  for (const finding of params.findings) {
    const comment = buildComment(finding, params.positionMap, params.model)
    if (comment) valid.push({ finding, comment })
    else invalid.push(finding)
  }

  if (valid.length === 0) {
    return {
      reviewId: null,
      postedFindings: [],
      unpostedFindings: invalid,
      fallbackToSummaryOnly: false
    }
  }

  if (params.dryRun) {
    return {
      reviewId: null,
      postedFindings: valid.map((v) => v.finding),
      unpostedFindings: invalid,
      fallbackToSummaryOnly: false
    }
  }

  try {
    const res = await client.rest.pulls.createReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      event: 'COMMENT',
      body: params.body ?? '',
      comments: valid.map((v) => v.comment)
    })
    const data = res.data as { id?: number }
    return {
      reviewId: typeof data.id === 'number' ? data.id : null,
      postedFindings: valid.map((v) => v.finding),
      unpostedFindings: invalid,
      fallbackToSummaryOnly: false
    }
  } catch (error) {
    const status = statusOf(error)
    if (status === 403) {
      throw new GithubApiError(
        'GitHub rejected pulls.createReview with 403 Forbidden.',
        'This action needs `permissions: pull-requests: write` in the calling workflow.'
      )
    }
    if (status === 422) {
      const blamed = extractBlamedPositions(error)
      const excluded: Finding[] = []
      const retryValid = valid.filter((v) => {
        const isBlamed = blamed.some((b) => b.path === v.comment.path && b.line === v.comment.line)
        if (isBlamed) excluded.push(v.finding)
        return !isBlamed
      })

      // Only worth a retry if the error text actually let us drop at least
      // one comment — otherwise a second call would fail the same way.
      if (excluded.length > 0 && retryValid.length > 0) {
        try {
          const retryRes = await client.rest.pulls.createReview({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.prNumber,
            event: 'COMMENT',
            body: params.body ?? '',
            comments: retryValid.map((v) => v.comment)
          })
          const retryData = retryRes.data as { id?: number }
          logger.warning(
            'pulls.createReview was rejected with 422; retried once after dropping ' +
              `${excluded.length} comment(s) GitHub named as the problem.`
          )
          return {
            reviewId: typeof retryData.id === 'number' ? retryData.id : null,
            postedFindings: retryValid.map((v) => v.finding),
            unpostedFindings: [...invalid, ...excluded],
            fallbackToSummaryOnly: false
          }
        } catch (retryError) {
          if (statusOf(retryError) !== 422) throw retryError
          // Retry still rejected -> give up on identifying the culprit and
          // fall through to the summary-only fallback below.
        }
      }

      logger.warning(
        'pulls.createReview was rejected with 422 (a comment likely pointed outside the diff); ' +
          'falling back to a summary-only comment with every finding listed as text (§7.5 layer 3).'
      )
      return {
        reviewId: null,
        postedFindings: [],
        unpostedFindings: [...params.findings],
        fallbackToSummaryOnly: true
      }
    }
    throw error
  }
}

interface RawReviewComment {
  path?: unknown
  line?: unknown
  body?: unknown
}

/**
 * Reads every already-posted inline review comment on the PR (FR-65, R-9),
 * following pagination (100/page, T5.13) — used by `report/dedupe.ts` to
 * avoid reposting the same finding on a subsequent run.
 */
export async function listExistingReviewComments (
  client: OctokitClient,
  params: { owner: string; repo: string; prNumber: number }
): Promise<ExistingReviewComment[]> {
  const perPage = 100
  const all: ExistingReviewComment[] = []
  for (let page = 1; ; page++) {
    const res = await client.rest.pulls.listReviewComments({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: perPage,
      page
    })
    const pageComments = res.data as RawReviewComment[]
    for (const c of pageComments) {
      all.push({
        path: typeof c.path === 'string' ? c.path : '',
        line: typeof c.line === 'number' ? c.line : null,
        body: typeof c.body === 'string' ? c.body : ''
      })
    }
    if (pageComments.length < perPage) break
  }
  return all
}
