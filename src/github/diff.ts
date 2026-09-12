import type { OctokitClient } from './context.ts'
import {
  parseDiff,
  parseHunks,
  type DiffFile,
  type DiffFileStatus,
  type SkippedFile
} from './diff-parse.ts'
import { logger } from '../util/logger.ts'
import { GithubApiError } from '../util/errors.ts'

export type DiffSource = 'full' | 'incremental' | 'list_files'

export interface GetDiffParams {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  incremental: boolean
  lastReviewedSha?: string | null | undefined
}

export interface DiffResult {
  files: DiffFile[]
  source: DiffSource
  skippedFiles: SkippedFile[]
  /** Set only for the "nothing changed since the last review" early exit (T2.40). */
  skippedReason?: 'no_changes'
}

interface HttpErrorLike {
  status?: number
}

function isNotFoundError (error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as HttpErrorLike).status === 404
}

function extractDiffText (res: { data: unknown }): string {
  return typeof res.data === 'string' ? res.data : String(res.data)
}

async function fetchFullDiff (client: OctokitClient, params: GetDiffParams): Promise<DiffResult> {
  const res = await client.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    mediaType: { format: 'diff' }
  })
  return { files: parseDiff(extractDiffText(res)), source: 'full', skippedFiles: [] }
}

interface ListFilesEntry {
  filename: string
  status: string
  patch?: string
  previous_filename?: string
}

const LIST_FILES_STATUS_MAP: Record<string, DiffFileStatus> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'modified',
  changed: 'modified',
  unchanged: 'modified'
}

/**
 * FR-19a fallback: when GitHub refuses to return `pulls.get`'s unified diff
 * (typically because the PR is too large), reconstruct a file list from
 * `pulls.listFiles` (paginated, 100/page). Files without a `patch` field
 * (binary or too large for GitHub to compute a patch for) are reported as
 * skipped/unreviewable per FR-19 (R-TRUNC), never silently dropped.
 */
async function fetchDiffFromListFiles (
  client: OctokitClient,
  params: Pick<GetDiffParams, 'owner' | 'repo' | 'prNumber'>
): Promise<DiffResult> {
  const perPage = 100
  const files: DiffFile[] = []
  const skippedFiles: SkippedFile[] = []

  for (let page = 1; ; page++) {
    const res = await client.rest.pulls.listFiles({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: perPage,
      page
    })
    const pageFiles = res.data as ListFilesEntry[]

    for (const f of pageFiles) {
      if (!f.patch) {
        skippedFiles.push({
          path: f.filename,
          reason: 'No patch available from pulls.listFiles (binary file or diff too large).'
        })
        continue
      }
      files.push({
        path: f.filename,
        oldPath: f.status === 'renamed' ? (f.previous_filename ?? null) : null,
        status: LIST_FILES_STATUS_MAP[f.status] ?? 'modified',
        binary: false,
        hunks: parseHunks(f.patch)
      })
    }

    if (pageFiles.length < perPage) break
  }

  return { files, source: 'list_files', skippedFiles }
}

/**
 * Resolves the PR diff to review (§7.3). Order of decisions:
 * 1. `incremental && lastReviewedSha === headSha` -> no-op, no network call
 *    at all (T2.40).
 * 2. `incremental && lastReviewedSha` -> `repos.compareCommits`, both using
 *    `mediaType: {format: 'diff'}` so the parser always sees the same
 *    unified-diff text regardless of source. A 404 (force-push invalidated
 *    the base sha) falls back to the full diff with a warning, never throws
 *    (T2.39).
 * 3. Otherwise (or after that fallback) -> `pulls.get` full diff. If GitHub
 *    itself fails to return it (PR too large) -> FR-19a `pulls.listFiles`
 *    fallback (T2.41-T2.43).
 */
export async function getDiff (client: OctokitClient, params: GetDiffParams): Promise<DiffResult> {
  const { incremental, lastReviewedSha, headSha } = params

  if (incremental && lastReviewedSha && lastReviewedSha === headSha) {
    return { files: [], source: 'incremental', skippedFiles: [], skippedReason: 'no_changes' }
  }

  if (incremental && lastReviewedSha) {
    try {
      const res = await client.rest.repos.compareCommits({
        owner: params.owner,
        repo: params.repo,
        base: lastReviewedSha,
        head: headSha,
        mediaType: { format: 'diff' }
      })
      return { files: parseDiff(extractDiffText(res)), source: 'incremental', skippedFiles: [] }
    } catch (error) {
      if (!isNotFoundError(error)) throw new GithubApiError(errorMessage(error))
      logger.warning(
        `repos.compareCommits(base=${lastReviewedSha}, head=${headSha}) returned 404 ` +
          '(likely a force-push invalidated the base commit); falling back to the full PR diff.'
      )
    }
  } else if (incremental && !lastReviewedSha) {
    logger.warning(
      'incremental review was requested but no last_reviewed_sha is available yet; ' +
        'falling back to a full PR diff (FR-17).'
    )
  }

  try {
    return await fetchFullDiff(client, params)
  } catch {
    logger.warning(
      'pulls.get failed to return a unified diff (the PR is likely too large); ' +
        'falling back to pulls.listFiles (FR-19a).'
    )
    return await fetchDiffFromListFiles(client, params)
  }
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
