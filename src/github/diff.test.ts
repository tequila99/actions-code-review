import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDiff } from './diff.ts'
import { logger } from '../util/logger.ts'
import { GithubApiError } from '../util/errors.ts'
import { createOctokitMock } from '../../test/helpers/octokit-mock.ts'

const BASE_PARAMS = { owner: 'tequila99', repo: 'actions-code-review', prNumber: 42 }

const SIMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  ''
].join('\n')

test('T2.36: incremental: false calls pulls.get with mediaType: {format: "diff"}', async () => {
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => ({ data: SIMPLE_DIFF }))

  const result = await getDiff(client, { ...BASE_PARAMS, headSha: 'head1', incremental: false })

  assert.equal(result.source, 'full')
  assert.equal(result.files.length, 1)
  assert.equal(client.rest.pulls.get.mock.calls.length, 1)
  const args = client.rest.pulls.get.mock.calls[0]?.arguments[0] as Record<string, unknown>
  assert.deepEqual(args.mediaType, { format: 'diff' })
})

test('T2.37: incremental: true + valid last_reviewed_sha calls compareCommits(base, head) with mediaType: {format: "diff"}', async () => {
  const client = createOctokitMock()
  client.rest.repos.compareCommits.mock.mockImplementation(async () => ({ data: SIMPLE_DIFF }))

  const result = await getDiff(client, {
    ...BASE_PARAMS,
    headSha: 'head2',
    incremental: true,
    lastReviewedSha: 'base1'
  })

  assert.equal(result.source, 'incremental')
  assert.equal(client.rest.repos.compareCommits.mock.calls.length, 1)
  const args = client.rest.repos.compareCommits.mock.calls[0]?.arguments[0] as Record<
    string,
    unknown
  >
  assert.equal(args.base, 'base1')
  assert.equal(args.head, 'head2')
  assert.deepEqual(args.mediaType, { format: 'diff' })
  assert.equal(client.rest.pulls.get.mock.calls.length, 0)
})

test('T2.38: incremental: true, last_reviewed_sha missing -> fallback to full diff + warning (FR-17)', async (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => ({ data: SIMPLE_DIFF }))

  const result = await getDiff(client, {
    ...BASE_PARAMS,
    headSha: 'head3',
    incremental: true,
    lastReviewedSha: undefined
  })

  assert.equal(result.source, 'full')
  assert.equal(client.rest.pulls.get.mock.calls.length, 1)
  assert.ok(warning.mock.calls.length >= 1)
})

test('T2.39: compareCommits 404 (force-push) -> fallback to full diff + warning, no throw', async (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.repos.compareCommits.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 })
  })
  client.rest.pulls.get.mock.mockImplementation(async () => ({ data: SIMPLE_DIFF }))

  const result = await getDiff(client, {
    ...BASE_PARAMS,
    headSha: 'head4',
    incremental: true,
    lastReviewedSha: 'stale-base'
  })

  assert.equal(result.source, 'full')
  assert.equal(client.rest.pulls.get.mock.calls.length, 1)
  assert.ok(warning.mock.calls.length >= 1)
})

test('T2.40: last_reviewed_sha === head_sha -> early exit, skippedReason: "no_changes", no network call', async () => {
  const client = createOctokitMock()
  const result = await getDiff(client, {
    ...BASE_PARAMS,
    headSha: 'same-sha',
    incremental: true,
    lastReviewedSha: 'same-sha'
  })

  assert.equal(result.skippedReason, 'no_changes')
  assert.deepEqual(result.files, [])
  assert.equal(client.rest.pulls.get.mock.calls.length, 0)
  assert.equal(client.rest.repos.compareCommits.mock.calls.length, 0)
  assert.equal(client.rest.pulls.listFiles.mock.calls.length, 0)
})

test('T2.41: pulls.get fails (PR too large) -> fallback to pulls.listFiles (FR-19a)', async (t) => {
  t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw new Error('This diff is too large to be displayed')
  })
  client.rest.pulls.listFiles.mock.mockImplementation(async () => ({
    data: [{ filename: 'src/x.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' }]
  }))

  const result = await getDiff(client, { ...BASE_PARAMS, headSha: 'head5', incremental: false })

  assert.equal(result.source, 'list_files')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0]?.path, 'src/x.ts')
  assert.equal(client.rest.pulls.listFiles.mock.calls.length, 1)
})

test('T2.42: pulls.listFiles gives 2 pages of 100 files -> both read, all files collected', async (t) => {
  t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw new Error('too large')
  })
  let calls = 0
  client.rest.pulls.listFiles.mock.mockImplementation(async () => {
    calls++
    const page = calls
    const start = (page - 1) * 100
    if (page > 2) return { data: [] }
    return {
      data: Array.from({ length: 100 }, (_, i) => ({
        filename: `src/file_${start + i}.ts`,
        status: 'modified',
        patch: '@@ -1,1 +1,1 @@\n-old\n+new'
      }))
    }
  })

  const result = await getDiff(client, { ...BASE_PARAMS, headSha: 'head6', incremental: false })

  assert.equal(result.source, 'list_files')
  assert.equal(result.files.length, 200)
  assert.equal(calls, 3) // 2 full pages + 1 empty page to detect the end
})

// ---------------------------------------------------------------------------
// #15: `pulls.get` failures only fall back to `pulls.listFiles` for the
// "diff genuinely too big to render" cases (406/422, or an untyped error
// whose message names the size/diff problem); everything else (401/403/404,
// network errors) must surface as a `GithubApiError` instead of being masked
// by a second, likely-identical `listFiles` failure.
// ---------------------------------------------------------------------------

test('TAB1: pulls.get fails with status 403 -> throws GithubApiError, no listFiles fallback', async () => {
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Forbidden'), { status: 403 })
  })

  await assert.rejects(
    getDiff(client, { ...BASE_PARAMS, headSha: 'head8', incremental: false }),
    GithubApiError
  )
  assert.equal(client.rest.pulls.listFiles.mock.calls.length, 0)
})

test('TAB2: pulls.get fails with status 422 -> falls back to pulls.listFiles (FR-19a)', async (t) => {
  t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Unprocessable Entity'), { status: 422 })
  })
  client.rest.pulls.listFiles.mock.mockImplementation(async () => ({
    data: [{ filename: 'src/y.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' }]
  }))

  const result = await getDiff(client, { ...BASE_PARAMS, headSha: 'head9', incremental: false })

  assert.equal(result.source, 'list_files')
  assert.equal(client.rest.pulls.listFiles.mock.calls.length, 1)
})

test('TAB3: pulls.get fails with no status and an unrelated message -> throws GithubApiError, no listFiles fallback', async () => {
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw new Error('ECONNRESET')
  })

  await assert.rejects(
    getDiff(client, { ...BASE_PARAMS, headSha: 'head10', incremental: false }),
    GithubApiError
  )
  assert.equal(client.rest.pulls.listFiles.mock.calls.length, 0)
})

test('T2.43: a listFiles entry with no "patch" field goes to skippedFiles, not the review', async (t) => {
  t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.pulls.get.mock.mockImplementation(async () => {
    throw new Error('too large')
  })
  client.rest.pulls.listFiles.mock.mockImplementation(async () => ({
    data: [
      { filename: 'src/reviewable.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
      { filename: 'assets/huge.bin', status: 'modified' } // no patch field
    ]
  }))

  const result = await getDiff(client, { ...BASE_PARAMS, headSha: 'head7', incremental: false })

  assert.equal(result.files.length, 1)
  assert.equal(result.files[0]?.path, 'src/reviewable.ts')
  assert.equal(result.skippedFiles.length, 1)
  assert.equal(result.skippedFiles[0]?.path, 'assets/huge.bin')
})
