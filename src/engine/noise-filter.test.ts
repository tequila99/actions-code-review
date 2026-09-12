import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterNoise } from './noise-filter.ts'
import type { Finding } from './types.ts'
import { createFakeProvider, makeCompletionResponse } from '../../test/helpers/fake-provider.ts'
import { logger } from '../util/logger.ts'

const SIGNAL = new AbortController().signal

function finding (overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'a.ts',
    line: 1,
    severity: 'low',
    category: 'style',
    message: 'a nitpick',
    ...overrides
  }
}

test('TV.4: empty findings -> no provider call, empty result', async () => {
  const provider = createFakeProvider()
  const result = await filterNoise([], provider, SIGNAL)
  assert.deepEqual(result, { kept: [], filteredCount: 0 })
  assert.equal(provider.complete.mock.callCount(), 0)
})

test('TV.5: "keep" lists a subset of indices -> only those findings survive', async () => {
  const findings = [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 3 })]
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: JSON.stringify({ keep: [0, 2] }) })
  )
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.filteredCount, 1)
  assert.deepEqual(result.kept.map((f) => f.line), [1, 3])
  assert.equal(result.note, undefined)
})

test('TV.6: "keep" lists every index -> nothing filtered, no note (a success, not a failure)', async () => {
  const findings = [finding({ line: 1 }), finding({ line: 2 })]
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: JSON.stringify({ keep: [0, 1] }) })
  )
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.filteredCount, 0)
  assert.equal(result.kept.length, 2)
  assert.equal(result.note, undefined)
})

test('TV.7: out-of-range/non-integer indices in "keep" are ignored, not crashed on', async () => {
  const findings = [finding({ line: 1 }), finding({ line: 2 })]
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: JSON.stringify({ keep: [0, 5, -1, 1.5, 'x'] }) })
  )
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.deepEqual(result.kept.map((f) => f.line), [1])
  assert.equal(result.filteredCount, 1)
})

test('TV.8: malformed response ("keep" missing) fails open -> all findings kept, with a note', async (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const findings = [finding()]
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: '{}' }))
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.kept.length, 1)
  assert.equal(result.filteredCount, 0)
  assert.match(result.note!, /failed/i)
  assert.equal(warning.mock.callCount(), 1)
})

test('TV.9: a provider call throwing fails open -> all findings kept, with a note', async () => {
  const findings = [finding(), finding({ line: 2 })]
  const provider = createFakeProvider(async () => {
    throw new Error('HTTP 500 from upstream')
  })
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.kept.length, 2)
  assert.equal(result.filteredCount, 0)
  assert.match(result.note!, /failed/i)
})

test('TV.10: an empty (null-text) response fails open -> all findings kept', async () => {
  const findings = [finding()]
  const provider = createFakeProvider(async () => makeCompletionResponse({ text: null }))
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.kept.length, 1)
  assert.equal(result.filteredCount, 0)
})

test('TV.11: "keep": [] (everything filtered) -> zero findings survive', async () => {
  const findings = [finding(), finding({ line: 2 })]
  const provider = createFakeProvider(async () =>
    makeCompletionResponse({ text: JSON.stringify({ keep: [] }) })
  )
  const result = await filterNoise(findings, provider, SIGNAL)
  assert.equal(result.kept.length, 0)
  assert.equal(result.filteredCount, 2)
})

test('TV.12: sends a responseSchema and the findings text in the user message', async () => {
  const findings = [finding({ message: 'unique-marker-xyz' })]
  const provider = createFakeProvider(async (req) => {
    assert.ok(req.responseSchema, 'must request structured output')
    const userMessage = req.messages.find((m) => m.role === 'user')
    assert.ok(userMessage && userMessage.content.includes('unique-marker-xyz'))
    return makeCompletionResponse({ text: JSON.stringify({ keep: [0] }) })
  })
  await filterNoise(findings, provider, SIGNAL)
  assert.equal(provider.complete.mock.callCount(), 1)
})
