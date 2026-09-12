import type { OctokitClient } from './context.ts'
import { logger } from '../util/logger.ts'
import { ENTRY_START, ENTRY_END } from '../report/format.ts'

/**
 * Marker HTML comment that identifies the action's own summary comment on a
 * PR, so it can be found and updated instead of accumulating a new comment
 * on every run (FR-63).
 */
export const STICKY_MARKER = '<!-- actions-code-review:summary -->'

/**
 * Дополнение C: how many of the most recent run entries the sticky comment
 * keeps (newest first). Older entries are dropped, with a note appended
 * about the truncation.
 */
export const STICKY_HISTORY_MAX_ENTRIES = 20

/**
 * Machine-readable state block embedded inside the sticky comment body
 * (FR-64), carrying `last_reviewed_sha` for incremental review (§7.3).
 */
const STATE_BLOCK_PATTERN = /<!-- actions-code-review:state (.*?) -->/s

export interface StickyCommentState {
  last_reviewed_sha: string
  version: number
}

export interface StickyComment {
  id: number
  body: string
}

interface IssueCommentLike {
  id: number
  body?: string | null | undefined
  created_at?: string
}

/** Reads every PR comment via `issues.listComments`, following pagination. */
async function listAllComments (
  client: OctokitClient,
  params: { owner: string; repo: string; prNumber: number }
): Promise<IssueCommentLike[]> {
  const perPage = 100
  const all: IssueCommentLike[] = []
  for (let page = 1; ; page++) {
    const res = await client.rest.issues.listComments({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.prNumber,
      per_page: perPage,
      page
    })
    const pageComments = res.data as IssueCommentLike[]
    all.push(...pageComments)
    if (pageComments.length < perPage) break
  }
  return all
}

/**
 * Finds the action's sticky summary comment among a PR's comments (T2.5,
 * T2.6). If more than one comment carries the marker (shouldn't normally
 * happen, but a previous run could have raced), the earliest one (first in
 * `listComments`' chronological order) is used and the rest are warned
 * about, never thrown on.
 */
export async function findStickyComment (
  client: OctokitClient,
  params: { owner: string; repo: string; prNumber: number }
): Promise<StickyComment | null> {
  const comments = await listAllComments(client, params)
  const matches = comments.filter((c) => (c.body ?? '').includes(STICKY_MARKER))

  if (matches.length === 0) return null

  if (matches.length > 1) {
    const extraIds = matches.slice(1).map((c) => c.id)
    logger.warning(
      `Found ${matches.length} PR comments carrying the ${STICKY_MARKER} marker; using the ` +
        `earliest (id=${matches[0]!.id}) and ignoring the rest (ids: ${extraIds.join(', ')}).`
    )
  }

  const first = matches[0]!
  return { id: first.id, body: first.body ?? '' }
}

/**
 * Extracts and validates the `<!-- actions-code-review:state {...} -->`
 * block from a sticky comment body (T2.7-T2.9). Returns `null` (never
 * throws) if the block is absent or its JSON is malformed/incomplete — this
 * is the deliberate fallback-to-full-diff path required by FR-17.
 */
export function extractStickyState (body: string): StickyCommentState | null {
  const match = STATE_BLOCK_PATTERN.exec(body)
  if (!match) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? '')
  } catch {
    logger.warning(
      'Sticky comment state block contains invalid JSON; falling back to a full diff review.'
    )
    return null
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).last_reviewed_sha !== 'string' ||
    typeof (parsed as Record<string, unknown>).version !== 'number'
  ) {
    logger.warning(
      'Sticky comment state block is missing "last_reviewed_sha"/"version"; falling back to a full diff review.'
    )
    return null
  }

  const state = parsed as { last_reviewed_sha: string; version: number }
  return { last_reviewed_sha: state.last_reviewed_sha, version: state.version }
}

/**
 * Builds the machine-readable state block (FR-64). Uses the exact same
 * shape `extractStickyState` parses (`last_reviewed_sha`/`version`), so a
 * write followed by a read always round-trips (T5.20).
 */
export function buildStateBlock (state: StickyCommentState): string {
  return `<!-- actions-code-review:state ${JSON.stringify(state)} -->`
}

/**
 * Builds the full sticky-comment body as a capped, newest-first history of
 * run entries (Дополнение C), replacing the old "fully overwritten every
 * run" behaviour.
 *
 * `existingBody` is scanned for `ENTRY_START...ENTRY_END` blocks (non-greedy,
 * multiline). Anything that doesn't parse as well-formed entries — `null`,
 * empty, the old pre-Дополнение-C flat format (no entry delimiters at all),
 * or a corrupted/unclosed entry marker — is treated as zero existing
 * entries rather than thrown on, so this stays backward-compatible with
 * comments written before this feature existed.
 *
 * `newEntryMarkdown` is prepended (newest first), the combined list is
 * capped to `maxEntries`, and — only when entries were actually dropped — a
 * truncation note is appended after the entries, in the given `language`
 * (defaults to English; `'ru'` gets a Russian translation — this is a
 * user-facing PR comment, so it follows `review.language`, unlike the
 * `## AI Code Review — History` heading above it, which stays English on
 * purpose as a stable marker for humans/parsing).
 */
export function buildStickyBody (
  existingBody: string | null,
  newEntryMarkdown: string,
  maxEntries: number = STICKY_HISTORY_MAX_ENTRIES,
  language: string = 'en'
): string {
  const entryPattern = new RegExp(`${ENTRY_START}.*?${ENTRY_END}`, 'gs')
  const existingEntries = (existingBody ?? '').match(entryPattern) ?? []

  const allEntries = [newEntryMarkdown, ...existingEntries]
  const entries = allEntries.slice(0, maxEntries)

  let body = `${STICKY_MARKER}\n\n## AI Code Review — History\n\n${entries.join('\n\n')}`

  if (allEntries.length > maxEntries) {
    body += historyTruncationNote(language, maxEntries)
  }

  return body
}

function historyTruncationNote (language: string, maxEntries: number): string {
  return language === 'ru'
    ? `\n\n_Показаны последние ${maxEntries} прогонов; более старые записи скрыты ` +
        '(полная история — в комментариях к review на GitHub)._'
    : `\n\n_Showing the last ${maxEntries} runs; older entries are hidden ` +
        '(the full history is in the review comments on GitHub)._'
}

export interface UpsertStickyCommentParams {
  owner: string
  repo: string
  prNumber: number
  entryMarkdown: string
  state: StickyCommentState
  /** §7.3 step 6 / FR-68: state must not be written and no comment published. */
  dryRun: boolean
  /** `review.language` (defaults to English): controls the history-truncation note's language. */
  language?: string
}

export interface UpsertStickyCommentResult {
  /** `null` when `dryRun` (nothing was created/updated) or when a create was skipped for any other reason. */
  commentId: number | null
  created: boolean
}

/**
 * Creates or updates the action's sticky summary comment (FR-63/FR-64,
 * Дополнение C). The body is `buildStickyBody(existing body, entryMarkdown)`
 * — the new entry prepended onto the capped run history — followed by the
 * machine-readable state block. `STICKY_MARKER` is always injected by
 * `buildStickyBody` itself, so it stays a single HTML comment, invisible in
 * the rendered PR (T5.19), regardless of what `entryMarkdown` contains.
 */
export async function upsertStickyComment (
  client: OctokitClient,
  params: UpsertStickyCommentParams
): Promise<UpsertStickyCommentResult> {
  const existing = await findStickyComment(client, {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber
  })

  if (params.dryRun) {
    return { commentId: existing?.id ?? null, created: false }
  }

  const historyBody = buildStickyBody(
    existing?.body ?? null,
    params.entryMarkdown,
    STICKY_HISTORY_MAX_ENTRIES,
    params.language ?? 'en'
  )
  const body = `${historyBody}\n\n${buildStateBlock(params.state)}`

  if (existing) {
    await client.rest.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: existing.id,
      body
    })
    return { commentId: existing.id, created: false }
  }

  const res = await client.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    body
  })
  const data = res.data as { id?: number }
  return { commentId: typeof data.id === 'number' ? data.id : null, created: true }
}
