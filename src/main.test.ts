import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, internals, defaultOutputs, type PrPhaseResult, type DiffPhaseResult } from './main.ts'
import { withEnvAsync } from '../test/helpers/env.ts'
import { createOctokitMock } from '../test/helpers/octokit-mock.ts'
import { makeResolvedConfig } from '../test/helpers/resolved-config.ts'
import { buildPositionMap } from './github/position-map.ts'
import { formatReviewEntry, ENTRY_START, ENTRY_END } from './report/format.ts'
import { buildStickyBody } from './github/sticky-comment.ts'
import { logger } from './util/logger.ts'
import { CapabilityError, ProviderError } from './util/errors.ts'
import { registerSecret } from './util/secrets.ts'

// NB: `@actions/core` is a pure ESM package — its named exports are live
// bindings and cannot be monkey-patched with `t.mock.method(core, 'setFailed', ...)`
// (Node throws "Cannot redefine property"). Instead we observe the real,
// documented side effects of `core.setFailed`: it sets `process.exitCode = 1`
// and writes an `::error::...` annotation via `process.stdout.write`. We spy
// on `process.stdout.write` (a plain mutable method, not an ESM binding) and
// always restore `process.exitCode` afterwards so a passing test suite never
// leaks a non-zero exit code to the `node --test` process itself.

function captureStdoutWrites (t: import('node:test').TestContext): string[] {
  const writes: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

test('T0.1: run is exported and is a function', () => {
  assert.equal(typeof run, 'function')
})

test('T0.2: without GITHUB_EVENT_NAME=pull_request, core.setFailed is called with a message mentioning pull_request', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'push' }, () => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')
  assert.ok(
    writes.some((w) => w.includes('pull_request')),
    'core.setFailed message must mention pull_request'
  )
})

test('T0.2b: without GITHUB_EVENT_NAME set at all, core.setFailed is called with a message mentioning pull_request', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: undefined }, () => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')
  assert.ok(
    writes.some((w) => w.includes('pull_request')),
    'core.setFailed message must mention pull_request'
  )
})

test('T0.3: an exception inside run() does not propagate, it becomes core.setFailed', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)
  t.mock.method(internals, 'isPullRequestEvent', () => {
    throw new Error('boom from run() internals')
  })

  await assert.doesNotReject(() => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')
  assert.ok(
    writes.some((w) => w.includes('boom from run() internals')),
    'core.setFailed must be called with the caught error message'
  )
})

test('T0.4: run() does not call process.exit', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)
  const exit = t.mock.method(process, 'exit', () => {
    throw new Error('process.exit should not be called')
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'push' }, () => run())

  assert.equal(exit.mock.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Stage 5 (T5.46-T5.48): full-environment-mocked orchestration.
// ---------------------------------------------------------------------------

/** §8.2 PRD, verbatim - the single source of truth this test cross-checks T5.46 against. */
const PRD_OUTPUT_KEYS = [
  'review_id',
  'mode_used',
  'comments_posted',
  'files_reviewed',
  'files_skipped',
  'skipped_files',
  'findings_total',
  'severity_max',
  'tokens_input',
  'tokens_output',
  'cost_estimate_usd',
  'skipped_reason',
  'truncated',
  'findings_filtered'
]

/** Parses `::set-output name=<key>::<value>` commands out of captured stdout writes. */
function parseSetOutputCommands (writes: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /^::set-output name=([^:]+)::(.*)$/
  for (const write of writes) {
    for (const line of write.split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (match) result[match[1]!] = match[2]!
    }
  }
  return result
}

function samplePositionMap () {
  return buildPositionMap([
    {
      path: 'a.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: 'context', content: 'l1', newLineNumber: 1, oldLineNumber: 1 },
            { type: 'add', content: 'l2', newLineNumber: 2 },
            { type: 'context', content: 'l3', newLineNumber: 3, oldLineNumber: 2 }
          ]
        }
      ]
    }
  ])
}

test('T5.46: every output from §8.2 PRD (14 total) is set on a full happy path', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({ dry_run: false })
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 99 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 'PR title',
    body: 'PR body',
    headSha: 'abc123',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: {
      files: [
        {
          path: 'a.ts',
          oldPath: null,
          status: 'modified',
          binary: false,
          hunks: []
        }
      ],
      skipped: []
    },
    positionMap: samplePositionMap()
  }))
  t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [
        {
          path: 'a.ts',
          line: 2,
          severity: 'high' as const,
          category: 'correctness',
          message: 'bug here'
        }
      ],
      usage: { promptTokens: 100, completionTokens: 50, estimated: false },
      notes: [],
      truncated: false
    }
  }))

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  const outputs = parseSetOutputCommands(writes)
  for (const key of PRD_OUTPUT_KEYS) {
    assert.ok(key in outputs, `missing output "${key}"`)
  }
  assert.equal(Object.keys(outputs).length, PRD_OUTPUT_KEYS.length)
  assert.equal(outputs.findings_total, '1')
  assert.equal(outputs.severity_max, 'high')
  assert.equal(outputs.skipped_reason, '')
})

test('TA.12: reviewResult.usage.costUsd set -> cost_estimate_usd uses it, not the budget.pricing estimate', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  // budget.pricing IS configured, but must lose to the provider-reported
  // actual cost (Дополнение A priority: real cost > budget.pricing > '').
  const config = makeResolvedConfig({
    dry_run: false,
    budget: { pricing: { input_per_1m: 3, output_per_1m: 15 } }
  })
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 99 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 'PR title',
    body: 'PR body',
    headSha: 'abc123',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: {
      files: [{ path: 'a.ts', oldPath: null, status: 'modified', binary: false, hunks: [] }],
      skipped: []
    },
    positionMap: samplePositionMap()
  }))
  t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [],
      // 100 in / 50 out at $3/$15 would estimate to 0.0011 via budget.pricing
      // (100/1e6*3 + 50/1e6*15 = 0.00105 -> "0.0011") — the real costUsd
      // below must win instead.
      usage: { promptTokens: 100, completionTokens: 50, estimated: false, costUsd: 0.005 },
      notes: [],
      truncated: false
    }
  }))

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.cost_estimate_usd, '0.0050')
  assert.notEqual(outputs.cost_estimate_usd, '0.0011')
})

test('T5.47: early exit (draft) -> skipped_reason "draft", safe-default outputs, exit 0', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const context = { client: createOctokitMock(), owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  const fetchPr = t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: true,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: 'draft'
  }))
  const fetchDiff = t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => {
    throw new Error('fetchDiff must not be called after a draft skip')
  })
  const runEngine = t.mock.method(internals, 'runEngine', async () => {
    throw new Error('runEngine must not be called after a draft skip')
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode, 'a skip must not fail the job')
  assert.equal(fetchPr.mock.calls.length, 1)
  assert.equal(fetchDiff.mock.calls.length, 0)
  assert.equal(runEngine.mock.calls.length, 0)

  const outputs = parseSetOutputCommands(writes)
  const expected = defaultOutputs('draft')
  for (const key of PRD_OUTPUT_KEYS) {
    assert.equal(
      outputs[key],
      (expected as unknown as Record<string, string>)[key],
      `output "${key}" mismatch`
    )
  }
})

test('T5.48: full happy path (everything mocked) - phases run in order config -> pr -> diff -> engine -> publish', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const order: string[] = []
  const config = makeResolvedConfig({ dry_run: false })
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => {
    order.push('publish')
    return { data: { id: 1 } }
  })
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => {
    order.push('config')
    return { config, languageExplicit: true }
  })
  t.mock.method(internals, 'createContext', () => {
    order.push('context')
    return context
  })
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => {
    order.push('pr')
    return { draft: false, labels: [], title: 't', body: null, headSha: 'sha', skipReason: null }
  })
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => {
    order.push('diff')
    return { target: { files: [], skipped: [] }, positionMap: samplePositionMap() }
  })
  t.mock.method(internals, 'runEngine', async () => {
    order.push('engine')
    return {
      engineName: 'diff' as const,
      reviewResult: {
        summary: 'ok',
        findings: [],
        usage: { promptTokens: 0, completionTokens: 0, estimated: false },
        notes: [],
        truncated: false
      }
    }
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.deepEqual(order, ['config', 'context', 'pr', 'diff', 'engine', 'publish'])
})

// ---------------------------------------------------------------------------
// Stage 8 (T8.5/T8.7/T8.8): budget.max_cost_usd pre-flight check, before
// internals.runEngine is ever called.
// ---------------------------------------------------------------------------

function sampleDiffFile () {
  return {
    path: 'a.ts',
    oldPath: null,
    status: 'modified' as const,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ type: 'add' as const, content: 'const x = 1', newLineNumber: 1 }]
      }
    ]
  }
}

test('T8.5: forecast exceeds budget.max_cost_usd -> skipped before internals.runEngine, skipped_reason "budget_exceeded"', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig({
    budget: { max_cost_usd: 0.001, pricing: { input_per_1m: 3, output_per_1m: 15 } }
  })
  const context = { client: createOctokitMock(), owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [sampleDiffFile()], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const runEngine = t.mock.method(internals, 'runEngine', async () => {
    throw new Error('runEngine must not be called when the pre-flight budget forecast is exceeded')
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode, 'a budget skip must not fail the job')
  assert.equal(runEngine.mock.calls.length, 0)

  const outputs = parseSetOutputCommands(writes)
  const expected = defaultOutputs('budget_exceeded')
  for (const key of PRD_OUTPUT_KEYS) {
    assert.equal(
      outputs[key],
      (expected as unknown as Record<string, string>)[key],
      `output "${key}" mismatch`
    )
  }
})

test('T8.7: budget.max_cost_usd not set -> no forecast check, runEngine still called', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [sampleDiffFile()], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const runEngine = t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [],
      usage: { promptTokens: 0, completionTokens: 0, estimated: false },
      notes: [],
      truncated: false
    }
  }))

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(runEngine.mock.calls.length, 1)
})

test('T8.8: budget.max_cost_usd set without budget.pricing -> warns, does not block runEngine', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig({ budget: { max_cost_usd: 0.001 } })
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  const warning = t.mock.method(logger, 'warning', () => {})
  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [sampleDiffFile()], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const runEngine = t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [],
      usage: { promptTokens: 0, completionTokens: 0, estimated: false },
      notes: [],
      truncated: false
    }
  }))

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(runEngine.mock.calls.length, 1, 'missing pricing must not block the run, only warn')
  assert.ok(warning.mock.calls.some((c) => /pricing/i.test(c.arguments[0] as string)))
})

// ---------------------------------------------------------------------------
// Stage 8 (T8.10): FR-72 grouped logging — config/diff/model/publish.
// ---------------------------------------------------------------------------

test('T8.10: run() wraps config/diff/model/publish in core.startGroup, in that order', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  octokit.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [], skipped: [] },
    positionMap: samplePositionMap()
  }))
  t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [],
      usage: { promptTokens: 0, completionTokens: 0, estimated: false },
      notes: [],
      truncated: false
    }
  }))

  const groupNames: string[] = []
  t.mock.method(logger, 'group', (name: string, fn: () => unknown) => {
    groupNames.push(name)
    return fn()
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.deepEqual(groupNames, ['config', 'diff', 'model', 'publish'])
})

// ---------------------------------------------------------------------------
// Stage 8 (T8.13): FR-23 — a `total_timeout_ms` cutoff mid-engine
// (`DiffEngine`/`AgentEngine` already stop cleanly on it, T4.34/TN.2) must
// still end up published, not silently dropped, once it reaches `run()`.
// ---------------------------------------------------------------------------

test('T8.13: an engine result truncated by a run-timeout is still published, with the note in the sticky comment and truncated: "true" in outputs', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  const config = makeResolvedConfig()
  const octokit = createOctokitMock()
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  let publishedBody = ''
  octokit.rest.issues.createComment.mock.mockImplementation(async (params: { body: string }) => {
    publishedBody = params.body
    return { data: { id: 1 } }
  })
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 't',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [sampleDiffFile()], skipped: [] },
    positionMap: samplePositionMap()
  }))
  t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'agent' as const,
    reviewResult: {
      summary: 'Partial review.',
      findings: [],
      usage: { promptTokens: 10, completionTokens: 5, estimated: false },
      notes: ['Agent review stopped early: the overall run timeout was reached.'],
      truncated: true
    }
  }))

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, originalExitCode, 'a timeout cutoff must not itself fail the job')
  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.truncated, 'true')
  assert.match(publishedBody, /overall run timeout was reached/)
})

// ---------------------------------------------------------------------------
// Дополнение B: PR-title-based review.language auto-detect, wired through
// `run()` end-to-end. Each test captures the `config` that actually reaches
// `internals.runEngine` (the single place `config.review.language` matters,
// see `engine/prompt/system.ts`).
// ---------------------------------------------------------------------------

const RUSSIAN_PR_TITLE = '[#66964375] Массовое изменение сдельных ставок по проектам и заданиям'

function mockRunEngineCapturingConfig (t: import('node:test').TestContext): {
  configs: ResolvedConfigCapture[]
} {
  const configs: ResolvedConfigCapture[] = []
  t.mock.method(internals, 'runEngine', async (config: ResolvedConfigCapture) => {
    configs.push(config)
    return {
      engineName: 'diff' as const,
      reviewResult: {
        summary: 'ok',
        findings: [],
        usage: { promptTokens: 0, completionTokens: 0, estimated: false },
        notes: [],
        truncated: false
      }
    }
  })
  return { configs }
}

type ResolvedConfigCapture = { review: { language: string } }

test('TB.13: languageExplicit: false + Russian PR title -> config.review.language is "ru" by the time runEngine runs', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig({ review: { language: 'en' } })
  const octokit = createOctokitMock()
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: false }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: RUSSIAN_PR_TITLE,
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const { configs } = mockRunEngineCapturingConfig(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(configs.length, 1)
  assert.equal(configs[0]!.review.language, 'ru')
})

test('TB.14: languageExplicit: true (e.g. "fr") + Russian PR title -> the explicit language wins, detection does not run', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig({ review: { language: 'fr' } })
  const octokit = createOctokitMock()
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: RUSSIAN_PR_TITLE,
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const { configs } = mockRunEngineCapturingConfig(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(configs.length, 1)
  assert.equal(configs[0]!.review.language, 'fr')
})

test('TB.15: languageExplicit: false + non-Russian PR title -> falls back to "en" (DEFAULTS.language)', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const config = makeResolvedConfig({ review: { language: 'en' } })
  const octokit = createOctokitMock()
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: false }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 'Fix login bug',
    body: null,
    headSha: 'sha',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: { files: [], skipped: [] },
    positionMap: samplePositionMap()
  }))
  const { configs } = mockRunEngineCapturingConfig(t)

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(configs.length, 1)
  assert.equal(configs[0]!.review.language, 'en')
})

// ---------------------------------------------------------------------------
// Дополнение C: sticky comment accumulates run history end-to-end through
// `run()` (only `internals.*` phases before publish are mocked, same as
// T5.46 - `publishAndBuildOutputs` and `upsertStickyComment` run for real).
// ---------------------------------------------------------------------------

test("TC.9: existing sticky comment with 1 history entry -> after a new run, issues.updateComment body has 2 entries, the new one first, with this run's reviewId/startedAt", async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  captureStdoutWrites(t)

  const previousEntry = formatReviewEntry({
    postedFindings: [],
    unpostedFindings: [],
    notes: [],
    truncated: false,
    skippedFiles: [],
    tokensInput: 10,
    tokensOutput: 5,
    mode: 'diff',
    model: 'gpt-4o-mini',
    costEstimateUsd: '0.0001',
    filesReviewed: 1,
    severityMax: 'none',
    findingsFiltered: 0,
    reviewId: 111,
    startedAt: '2026-01-01T00:00:00.000Z'
  })
  const existingCommentBody = buildStickyBody(null, previousEntry)

  const config = makeResolvedConfig({ dry_run: false })
  const octokit = createOctokitMock()
  octokit.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [{ id: 555, body: existingCommentBody }]
  }))
  octokit.rest.pulls.createReview.mock.mockImplementation(async () => ({
    data: { id: 4838288634 }
  }))
  const context = { client: octokit, owner: 'o', repo: 'r', prNumber: 1 }

  t.mock.method(internals, 'loadConfig', async () => ({ config, languageExplicit: true }))
  t.mock.method(internals, 'createContext', () => context)
  t.mock.method(internals, 'fetchPr', async (): Promise<PrPhaseResult> => ({
    draft: false,
    labels: [],
    title: 'PR title',
    body: 'PR body',
    headSha: 'abc123',
    skipReason: null
  }))
  t.mock.method(internals, 'fetchDiff', async (): Promise<DiffPhaseResult> => ({
    target: {
      files: [{ path: 'a.ts', oldPath: null, status: 'modified', binary: false, hunks: [] }],
      skipped: []
    },
    positionMap: samplePositionMap()
  }))
  t.mock.method(internals, 'runEngine', async () => ({
    engineName: 'diff' as const,
    reviewResult: {
      summary: 'ok',
      findings: [
        {
          path: 'a.ts',
          line: 2,
          severity: 'high' as const,
          category: 'correctness',
          message: 'bug here'
        }
      ],
      usage: { promptTokens: 20, completionTokens: 10, estimated: false },
      notes: [],
      truncated: false
    }
  }))

  const before = Date.now()
  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())
  const after = Date.now()

  assert.equal(octokit.rest.issues.updateComment.mock.calls.length, 1)
  assert.equal(octokit.rest.issues.createComment.mock.calls.length, 0)
  const call = octokit.rest.issues.updateComment.mock.calls[0]!.arguments[0] as {
    comment_id: number
    body: string
  }
  assert.equal(call.comment_id, 555)

  const entryPattern = new RegExp(`${ENTRY_START}.*?${ENTRY_END}`, 'gs')
  const entries = call.body.match(entryPattern) ?? []
  assert.equal(entries.length, 2)
  assert.ok(entries[0]!.includes('Review #4838288634'), 'the new entry must be first')
  assert.ok(entries[1]!.includes('Review #111'), 'the old entry must be second')

  const startedAtMatch = /### Review #4838288634 — (\S+)/.exec(entries[0]!)
  assert.ok(startedAtMatch, 'new entry header must contain a startedAt timestamp')
  const startedAtMs = Date.parse(startedAtMatch![1]!)
  assert.ok(
    startedAtMs >= before && startedAtMs <= after,
    'startedAt must be captured at the top of this run()'
  )
})

// ---------------------------------------------------------------------------
// Package A (TX1): run()'s catch block maps a CapabilityError to the
// dedicated `skipped_reason: 'capability_check_failed'` output (§8.2) and
// still sets every other output, on top of the AppError message handling
// TX2 (above) already covers.
// ---------------------------------------------------------------------------

test('TX1: CapabilityError thrown mid-run -> skipped_reason "capability_check_failed", all outputs still set', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  t.mock.method(internals, 'loadConfig', async () => {
    throw new CapabilityError(
      'The configured model does not support tool calling.',
      'Switch mode to "diff", or pick a tool-calling-capable model.'
    )
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')
  const outputs = parseSetOutputCommands(writes)
  assert.equal(outputs.skipped_reason, 'capability_check_failed')
  for (const key of PRD_OUTPUT_KEYS) {
    assert.ok(key in outputs, `missing output "${key}"`)
  }

  const allWrites = writes.join('')
  assert.ok(
    allWrites.includes('Switch mode to "diff"'),
    'setFailed message must include the AppError hint'
  )
})

test('TX2: ProviderError containing a registered secret -> setFailed message is redacted', async (t) => {
  const originalExitCode = process.exitCode
  t.after(() => {
    process.exitCode = originalExitCode
  })
  const writes = captureStdoutWrites(t)

  registerSecret('mainCatchSecretTokenXYZ')
  t.mock.method(internals, 'loadConfig', async () => {
    throw new ProviderError('Upstream rejected request, key=mainCatchSecretTokenXYZ')
  })

  await withEnvAsync({ GITHUB_EVENT_NAME: 'pull_request' }, () => run())

  assert.equal(process.exitCode, 1, 'core.setFailed must set process.exitCode = 1')

  // NB: registerSecret() itself writes an `::add-mask::<secret>` command
  // (that command's payload IS the raw value — the runner needs it verbatim
  // to know what to scrub from later logs). So the secret legitimately
  // appears once in captured stdout; what must never contain it is the
  // `::error::...` annotation core.setFailed() produces.
  const errorLine = writes.find((w) => w.includes('::error::'))
  assert.ok(errorLine, 'core.setFailed must emit an ::error:: annotation')
  assert.ok(
    !errorLine!.includes('mainCatchSecretTokenXYZ'),
    'the secret must never reach the core.setFailed error annotation'
  )
  assert.ok(errorLine!.includes('***'), 'redaction marker must be present')
})
