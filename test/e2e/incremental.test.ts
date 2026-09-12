import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, internals } from '../../src/main.ts'
import { withEnvAsync } from '../helpers/env.ts'
import { createOctokitMock } from '../helpers/octokit-mock.ts'
import { makeResolvedConfig } from '../helpers/resolved-config.ts'
import { STICKY_MARKER, buildStateBlock } from '../../src/github/sticky-comment.ts'
import {
  captureStdoutWrites,
  parseSetOutputCommands,
  buildDiffText,
  prMetadataResponse,
  runEngineWithFakeProvider,
  makeCompletionResponse
} from './helpers.ts'

// T6.14: an incremental run with an existing sticky comment (carrying
// `last_reviewed_sha`) must use `repos.compareCommits` (not the full-diff
// `pulls.get`) and end with the sticky comment's state updated to the new
// head sha.

test('T6.14: incremental run — compareCommits is used, sticky state is updated to the new head sha', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({ incremental: true })
  const octokit = createOctokitMock()

  const oldSha = 'sha-old-000'
  const newSha = 'sha-new-111'
  const existingBody = `Previous summary\n\n${STICKY_MARKER}\n\n${buildStateBlock({ last_reviewed_sha: oldSha, version: 1 })}`

  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [{ id: 555, body: existingBody, created_at: '2026-01-01T00:00:00Z' }]
  }))
  octokit.rest.pulls.get.mock.mockImplementation(async () =>
    prMetadataResponse({ headSha: newSha })
  )
  octokit.rest.repos.compareCommits.mock.mockImplementation(async () => ({
    data: buildDiffText(['src/a.ts'])
  }))
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 9 } }))
  octokit.rest.issues.updateComment.mock.mockImplementation(async () => ({ data: { id: 555 } }))

  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 4 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() => makeCompletionResponse())
  )

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode)

  assert.equal(
    octokit.rest.repos.compareCommits.mock.calls.length,
    1,
    'compareCommits is used for the incremental diff'
  )
  const compareArgs = octokit.rest.repos.compareCommits.mock.calls[0]!.arguments[0] as {
    base: string
    head: string
  }
  assert.equal(compareArgs.base, oldSha)
  assert.equal(compareArgs.head, newSha)
  assert.equal(octokit.rest.pulls.get.mock.calls.length, 1, 'the full-diff pulls.get is not used')

  assert.equal(
    octokit.rest.issues.updateComment.mock.calls.length,
    1,
    'the existing sticky comment is updated, not re-created'
  )
  const updateArgs = octokit.rest.issues.updateComment.mock.calls[0]!.arguments[0] as {
    comment_id: number
    body: string
  }
  assert.equal(updateArgs.comment_id, 555)
  assert.ok(
    updateArgs.body.includes(newSha),
    'the updated sticky comment body embeds the new head sha as last_reviewed_sha'
  )
  assert.ok(!updateArgs.body.includes(oldSha), 'the stale sha is no longer present')

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, '')
})
