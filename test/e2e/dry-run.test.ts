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

// T6.15: `dry_run: true` must produce zero mutating GitHub API calls
// (no `createReview`, no `createComment`/`updateComment`) while still
// filling in every §8.2 output as if the run had actually happened.

test('T6.15: dry_run — zero mutating calls, outputs still filled', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({ dry_run: true })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(['src/a.ts']) }
    return prMetadataResponse()
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))

  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 5 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() =>
      makeCompletionResponse({
        text: JSON.stringify({
          summary: 'One issue.',
          findings: [
            { path: 'src/a.ts', line: 2, severity: 'medium', category: 'style', message: 'Nit' }
          ]
        })
      })
    )
  )

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode)

  assert.equal(
    octokit.rest.pulls.createReview.mock.calls.length,
    0,
    'dry_run must not create a review'
  )
  assert.equal(
    octokit.rest.issues.createComment.mock.calls.length,
    0,
    'dry_run must not create the sticky comment'
  )
  assert.equal(
    octokit.rest.issues.updateComment.mock.calls.length,
    0,
    'dry_run must not update any comment'
  )

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, '')
  assert.equal(outputs.findings_total, '1')
  assert.equal(outputs.severity_max, 'medium')
  // §8.2: comments_posted reflects what was actually published, which is
  // nothing under dry_run, even though a finding exists.
  assert.equal(outputs.comments_posted, '0')
})

// TAA.6/TAA.7 (issue #12): a dry run publishes nothing, so the log is the
// only place the findings can be read from — a real run must not duplicate
// them there (they are already on the PR).
async function runWithOneFinding (t: Parameters<typeof captureStdoutWrites>[0], dryRun: boolean): Promise<{ log: string; octokit: ReturnType<typeof createOctokitMock> }> {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)
  const config = makeResolvedConfig({ dry_run: dryRun })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(['src/a.ts']) }
    return prMetadataResponse()
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 2 } }))
  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 5 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(
    internals,
    'runEngine',
    runEngineWithFakeProvider(() =>
      makeCompletionResponse({
        text: JSON.stringify({
          summary: 'One issue.',
          findings: [
            { path: 'src/a.ts', line: 2, severity: 'medium', category: 'style', message: 'DRYRUN_MARKER_NIT' }
          ]
        })
      })
    )
  )
  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())
  return { log: writes.join(''), octokit }
}

test('TAA.6: dry_run — findings are printed to the log', async (t) => {
  const { log } = await runWithOneFinding(t, true)
  assert.ok(log.includes('DRYRUN_MARKER_NIT'), 'dry-run log must contain the finding message')
  assert.match(log, /::group::dry-run: findings/)
})

test('TAA.7: real run — the dry-run findings block is not printed', async (t) => {
  const { log } = await runWithOneFinding(t, false)
  assert.ok(!log.includes('dry-run: findings'))
})

test('TAC.3: dry_run — the model summary is printed to the log', async (t) => {
  const { log } = await runWithOneFinding(t, true)
  assert.match(log, /Model summary:\s*One issue\./)
})

test('TAC.4: real run — the model summary is not dumped to the log', async (t) => {
  const { log } = await runWithOneFinding(t, false)
  assert.ok(!log.includes('Model summary:'))
})

test('TAD.22: real run — the model summary lands in the sticky comment, sanitised', async (t) => {
  const { octokit } = await runWithOneFinding(t, false)
  const body = (octokit.rest.issues.createComment.mock.calls[0]!.arguments[0] as { body: string }).body
  assert.match(body, /### Summary\n\nOne issue\./)
})
