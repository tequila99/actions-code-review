import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectEngine } from './selector.ts'
import { DiffEngine } from './diff-engine.ts'
import { AgentEngine } from './agent-engine.ts'
import { CapabilityError } from '../util/errors.ts'
import { logger } from '../util/logger.ts'
import { makeResolvedConfig } from '../../test/helpers/resolved-config.ts'
import { createFakeProvider, makeCompletionResponse } from '../../test/helpers/fake-provider.ts'

const SIGNAL = new AbortController().signal

test('T4.36: mode: "diff" -> a DiffEngine', async () => {
  const engine = await selectEngine(makeResolvedConfig({ mode: 'diff' }), createFakeProvider(), SIGNAL, 1)
  assert.ok(engine instanceof DiffEngine)
  assert.equal(engine.name, 'diff')
})

test('T4.37 (updated stage 7): mode: "agent" with a tool-calling-capable provider -> an AgentEngine', async () => {
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: null, toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'ok' } }] })
  )
  const engine = await selectEngine(makeResolvedConfig({ mode: 'agent' }), provider, SIGNAL, 1)
  assert.ok(engine instanceof AgentEngine)
  assert.equal(engine.name, 'agent')
})

test('T7.51 (selector integration): mode: "agent" with a non-tool-calling provider -> a diagnosable CapabilityError, DiffEngine is never returned', async () => {
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))
  await assert.rejects(
    () => selectEngine(makeResolvedConfig({ mode: 'agent' }), provider, SIGNAL, 1),
    (err: unknown) => {
      assert.ok(err instanceof CapabilityError)
      return true
    }
  )
})

test('T7.54: mode: "diff" never runs the capability probe', async () => {
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))
  await selectEngine(makeResolvedConfig({ mode: 'diff' }), provider, SIGNAL, 1)
  assert.equal(provider.complete.mock.callCount(), 0)
})

const TOOL_CALLING_PROVIDER = () =>
  createFakeProvider(async () =>
    makeCompletionResponse({ text: null, toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'ok' } }] })
  )
const NO_TOOL_CALLING_PROVIDER = () =>
  createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))

test('T8.1: mode: "auto", files <= auto_threshold_files, tool use supported -> an AgentEngine', async () => {
  const config = makeResolvedConfig({ mode: 'auto', auto_threshold_files: 8 })
  const engine = await selectEngine(config, TOOL_CALLING_PROVIDER(), SIGNAL, 8)
  assert.ok(engine instanceof AgentEngine)
})

test('T8.2: mode: "auto", files > auto_threshold_files -> a DiffEngine, no probe call', async () => {
  const config = makeResolvedConfig({ mode: 'auto', auto_threshold_files: 8 })
  const provider = TOOL_CALLING_PROVIDER()
  const engine = await selectEngine(config, provider, SIGNAL, 9)
  assert.ok(engine instanceof DiffEngine)
  assert.equal(provider.complete.mock.callCount(), 0, 'over-threshold never probes')
})

test('T8.3: mode: "auto", tool use not supported -> a DiffEngine regardless of file count', async () => {
  const config = makeResolvedConfig({ mode: 'auto', auto_threshold_files: 8 })
  const engine = await selectEngine(config, NO_TOOL_CALLING_PROVIDER(), SIGNAL, 1)
  assert.ok(engine instanceof DiffEngine)
})

test('T8.4: mode: "auto" logs its decision (engine name reflected in the log line)', async (t) => {
  const info = t.mock.method(logger, 'info', () => {})
  const config = makeResolvedConfig({ mode: 'auto', auto_threshold_files: 8 })

  const agentEngine = await selectEngine(config, TOOL_CALLING_PROVIDER(), SIGNAL, 8)
  assert.equal(agentEngine.name, 'agent')
  assert.match(info.mock.calls[0]!.arguments[0]!, /"agent"/)

  info.mock.resetCalls()
  const diffEngine = await selectEngine(config, TOOL_CALLING_PROVIDER(), SIGNAL, 9)
  assert.equal(diffEngine.name, 'diff')
  assert.match(info.mock.calls[0]!.arguments[0]!, /"diff"/)
})
