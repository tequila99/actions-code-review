import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeToolCalling, ensureAgentModeSupported } from './capability-probe.ts'
import { CapabilityError } from '../util/errors.ts'
import { createFakeProvider, makeCompletionResponse } from '../../test/helpers/fake-provider.ts'

test('T7.49: the model returning tool_calls on the probe resolves toolCalling: true', async () => {
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({
      text: null,
      toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'ok' } }]
    })
  )
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, true)
})

test('T7.50: the model returning text instead of tool_calls resolves toolCalling: false', async () => {
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, false)
})

test('T7.51: mode "agent" + toolCalling: false throws a diagnosable CapabilityError', async () => {
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))
  await assert.rejects(
    () => ensureAgentModeSupported(provider, new AbortController().signal, 'agent'),
    (err: unknown) => {
      if (!(err instanceof CapabilityError)) throw new Error('expected a CapabilityError')
      assert.match(err.toUserMessage(), /tool_calls/)
      assert.match(err.toUserMessage(), /--enable-auto-tool-choice/)
      assert.match(err.toUserMessage(), /mode: "diff"/)
      return true
    }
  )
})

test('T7.52: mode "auto" + toolCalling: false falls back silently (no throw)', async () => {
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: 'ok', toolCalls: [] }))
  const supported = await ensureAgentModeSupported(provider, new AbortController().signal, 'auto')
  assert.equal(supported, false)
})

test('T7.53: the probe result is cached — complete() is called only once per provider', async () => {
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: null, toolCalls: [{ id: '1', name: 'echo', arguments: {} }] })
  )
  const signal = new AbortController().signal
  await probeToolCalling(provider, signal)
  await probeToolCalling(provider, signal)
  await ensureAgentModeSupported(provider, signal, 'agent')
  assert.equal(provider.complete.mock.callCount(), 1)
})

test('T7.55: a probe that fails over the network is an error under "agent", a fallback under "auto"', async () => {
  const failingProvider = createFakeProvider(async () => {
    throw new Error('network error')
  })
  await assert.rejects(() =>
    ensureAgentModeSupported(failingProvider, new AbortController().signal, 'agent')
  )

  const anotherFailingProvider = createFakeProvider(async () => {
    throw new Error('network error')
  })
  const supported = await ensureAgentModeSupported(
    anotherFailingProvider,
    new AbortController().signal,
    'auto'
  )
  assert.equal(supported, false)
})

test('TK.1: the probe requests a token budget generous enough to survive reasoning-model overhead', async () => {
  // Reasoning-family models (o1/o3/gpt-5, etc.) spend hidden "reasoning" tokens out of the same
  // completion budget before ever emitting a tool call. A too-small probe budget makes a model
  // that genuinely supports tool calling look like it doesn't (real-world case: MWS-hosted gpt-5
  // returned finish_reason: "length" with zero tool_calls on a 64-token probe, but called the tool
  // fine once given room to think first).
  const provider = createFakeProvider(async (req) => {
    if (req.maxOutputTokens < 256) return makeCompletionResponse({ text: '', toolCalls: [] })
    return makeCompletionResponse({
      text: null,
      toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'ok' } }]
    })
  })
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, true)
})

test('TK.2: a truncated first attempt (finishReason "length") retries once with a larger budget', async () => {
  // Empirically, MWS-hosted gpt-5 burns a wildly variable number of reasoning tokens on this same
  // trivial probe across identical requests (observed: 128, 448, 512, 768+) — no single fixed
  // budget is reliably safe. `finishReason: "length"` with no tool_calls is an *inconclusive*
  // signal (cut off before finishing), not proof of no support, so it earns one retry with a much
  // larger budget before we give up.
  const provider = createFakeProvider(async (req) => {
    if (req.maxOutputTokens < 1000) {
      return makeCompletionResponse({ text: '', toolCalls: [], finishReason: 'length' })
    }
    return makeCompletionResponse({
      text: null,
      toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'ok' } }],
      finishReason: 'tool_calls'
    })
  })
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, true)
  assert.equal(provider.complete.mock.callCount(), 2)
  const calls = provider.complete.mock.calls
  assert.equal(calls.length, 2)
  assert.ok(calls[1]!.arguments[0].maxOutputTokens > calls[0]!.arguments[0].maxOutputTokens)
})

test('TK.3: still truncated after the retry gives up (no third attempt)', async () => {
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: '', toolCalls: [], finishReason: 'length' })
  )
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, false)
  assert.equal(provider.complete.mock.callCount(), 2)
})

test('TK.4: a clean (non-truncated) text response with no tool_calls does not retry at all', async () => {
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: 'ok', toolCalls: [], finishReason: 'stop' })
  )
  const supported = await probeToolCalling(provider, new AbortController().signal)
  assert.equal(supported, false)
  assert.equal(provider.complete.mock.callCount(), 1)
})
