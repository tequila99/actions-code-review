import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, internals } from '../../src/main.ts'
import { withEnvAsync } from '../helpers/env.ts'
import { createOctokitMock } from '../helpers/octokit-mock.ts'
import { makeResolvedConfig } from '../helpers/resolved-config.ts'
import {
  captureStdoutWrites,
  parseSetOutputCommands,
  buildDiffText,
  prMetadataResponse,
  runEngineWithFakeProvider,
  makeCompletionResponse
} from './helpers.ts'

// T6.10 (IMPLEMENTATION_PLAN.md "Этап 6"): full `run()` happy path against a
// mocked Octokit client + a fake provider. `internals.fetchPr`/`fetchDiff`
// run for real (the actual stage-6 wiring), only `loadConfig`/`createContext`
// (test-controlled inputs) and `runEngine` (network -> fake provider) are
// substituted, same DI seam as `src/main.test.ts`.

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts']

test('T6.10: happy path — PR with 3 files -> review created, 2 comments, sticky updated, outputs filled', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const octokit = createOctokitMock()

  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(PATHS) }
    return prMetadataResponse({ headSha: 'sha-happy-path' })
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 42 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))

  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 7 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() =>
      makeCompletionResponse({
        text: JSON.stringify({
          summary: 'Two issues found.',
          findings: [
            {
              path: 'src/a.ts',
              line: 2,
              severity: 'high',
              category: 'correctness',
              message: 'Bug A'
            },
            { path: 'src/b.ts', line: 2, severity: 'low', category: 'style', message: 'Nit B' }
          ]
        })
      })
    )
  )

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode, 'happy path must not fail the job')

  assert.equal(
    octokit.rest.pulls.createReview.mock.calls.length,
    1,
    'exactly one review is created'
  )
  const reviewCall = octokit.rest.pulls.createReview.mock.calls[0]!
  const reviewArgs = reviewCall.arguments[0] as { comments: unknown[] }
  assert.equal(reviewArgs.comments.length, 2, 'both findings are posted as inline comments')

  assert.equal(
    octokit.rest.issues.createComment.mock.calls.length,
    1,
    'the sticky summary comment is created (no prior sticky comment existed)'
  )

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.review_id, '42')
  assert.equal(outputs.mode_used, 'diff')
  assert.equal(outputs.comments_posted, '2')
  assert.equal(outputs.files_reviewed, '3')
  assert.equal(outputs.findings_total, '2')
  assert.equal(outputs.severity_max, 'high')
  assert.equal(outputs.skipped_reason, '')
})
