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
  prMetadataResponse
} from './helpers.ts'

// T6.11-T6.13: early-exit paths must never reach `runEngine` (zero model
// calls) — `internals.runEngine` is mocked to throw if it's ever invoked, so
// any regression that skips the skip-check shows up as a hard test failure
// rather than a silently-wrong output.

function neverCallRunEngine (t: import('node:test').TestContext) {
  return t.mock.method(internals, 'runEngine', async () => {
    throw new Error('runEngine must not be called on an early-exit path')
  })
}

test('T6.11: draft PR -> early exit, zero model calls', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({ filters: { skip_drafts: true } })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async () => prMetadataResponse({ draft: true }))
  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  const runEngine = neverCallRunEngine(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode, 'a skip must not fail the job')
  assert.equal(runEngine.mock.calls.length, 0)
  assert.equal(octokit.rest.pulls.createReview.mock.calls.length, 0)

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, 'draft')
  assert.equal(outputs.findings_total, '0')
})

test('T6.12: PR with a skip-label -> early exit', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({
    filters: { skip_drafts: false, skip_labels: ['no-ai-review'] }
  })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async () =>
    prMetadataResponse({ draft: false, labels: ['no-ai-review', 'bug'] })
  )
  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 2 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  const runEngine = neverCallRunEngine(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode)
  assert.equal(runEngine.mock.calls.length, 0)
  assert.equal(octokit.rest.pulls.createReview.mock.calls.length, 0)

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, 'label')
})

test('T6.13: every changed file is excluded -> no_changes, zero model calls', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({
    filters: { skip_drafts: false, exclude: ['**/*.ts'] }
  })
  const octokit = createOctokitMock()
  octokit.rest.pulls.get.mock.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.mediaType) return { data: buildDiffText(['src/a.ts', 'src/b.ts']) }
    return prMetadataResponse({ draft: false })
  })
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  const context = { client: octokit, owner: 'acme', repo: 'widgets', prNumber: 3 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  const runEngine = neverCallRunEngine(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode)
  assert.equal(runEngine.mock.calls.length, 0)
  assert.equal(octokit.rest.pulls.createReview.mock.calls.length, 0)

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, 'no_changes')
})
