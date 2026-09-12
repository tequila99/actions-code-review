import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, internals } from '../../src/main.ts'
import { withEnvAsync } from '../helpers/env.ts'
import { createOctokitMock } from '../helpers/octokit-mock.ts'
import { makeResolvedConfig } from '../helpers/resolved-config.ts'
import { ProviderError } from '../../src/util/errors.ts'
import {
  captureStdoutWrites,
  buildDiffText,
  prMetadataResponse,
  runEngineWithFakeProvider
} from './helpers.ts'

// T6.16-T6.17: two ways a "successful wiring" run can still need to fail the
// job — an unreachable provider (T6.16, nothing gets published) vs. a
// successful review that trips `fail_on_severity` (T6.17, the review is
// still published — FR-67, publish-before-fail).

test('T6.16: provider unavailable (retries exhausted) -> setFailed with a clear reason, sticky NOT updated', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(['src/a.ts']) }
    return prMetadataResponse()
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 6 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() => {
      throw new ProviderError(
        'All retries exhausted: upstream provider unreachable (ECONNREFUSED).'
      )
    })
  )

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')
  const allWrites = writes.join('')
  assert.ok(
    allWrites.includes('review batch') || allWrites.includes('provider'),
    'the failure message should give a clear, actionable reason'
  )

  assert.equal(octokit.rest.pulls.createReview.mock.calls.length, 0, 'no review is published')
  assert.equal(
    octokit.rest.issues.createComment.mock.calls.length,
    0,
    'the sticky comment is not created'
  )
  assert.equal(
    octokit.rest.issues.updateComment.mock.calls.length,
    0,
    'the sticky comment is not updated'
  )
})

test('T6.17: fail_on_severity: high + a high finding -> setFailed, but the review IS published first (FR-67)', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig({ review: { fail_on_severity: 'high' } })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(['src/a.ts']) }
    return prMetadataResponse()
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 100 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))

  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 8 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() => ({
      text: JSON.stringify({
        summary: 'Critical bug.',
        findings: [
          {
            path: 'src/a.ts',
            line: 2,
            severity: 'high',
            category: 'security',
            message: 'Critical bug'
          }
        ]
      }),
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, estimated: false },
      finishReason: 'stop',
      raw: null
    }))
  )

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, 1, 'the job must fail because fail_on_severity: high was tripped')
  assert.equal(
    octokit.rest.pulls.createReview.mock.calls.length,
    1,
    'the review is still published even though the job ultimately fails'
  )
  const reviewArgs = octokit.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: unknown[]
  }
  assert.equal(reviewArgs.comments.length, 1)
  assert.equal(
    octokit.rest.issues.createComment.mock.calls.length,
    1,
    'the sticky summary comment is still published'
  )
})
