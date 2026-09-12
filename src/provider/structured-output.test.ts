import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeStructured,
  extractJson,
  sanitizeJsonSchema,
  swappedMaxOutputTokensParam,
  type StructuredAttemptParams
} from './structured-output.ts'
import { HttpStatusError } from './retry.ts'
import { ProviderError } from '../util/errors.ts'
import type { CompletionRequest, CompletionResponse } from './types.ts'

function baseRequest (overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'You are a reviewer.',
    messages: [{ role: 'user', content: 'Review this diff.' }],
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    ...overrides
  }
}

function okResponse (text: string): CompletionResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, estimated: false },
    finishReason: 'stop',
    raw: {}
  }
}

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary']
}

test('T3.29: the first call requests response_format json_schema when a responseSchema is given', async () => {
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    assert.equal(params.responseFormatStage, 'json_schema')
    return okResponse('{"summary":"ok"}')
  })
  const result = await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.equal(attempt.mock.callCount(), 1)
  assert.equal(result.stage, 'json_schema')
})

test('T3.30: a 400 mentioning response_format/json_schema downgrades to json_object on the 2nd call', async () => {
  const calls: StructuredOutputStageLog[] = []
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    calls.push(params.responseFormatStage)
    if (calls.length === 1) {
      throw new HttpStatusError(400, 'Bad Request', {
        bodyText: 'Unknown parameter "response_format.json_schema".'
      })
    }
    return okResponse('{"summary":"ok"}')
  })
  const result = await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.deepEqual(calls, ['json_schema', 'json_object'])
  assert.equal(result.stage, 'json_object')
})

test('T3.31: a second 400 downgrades further to no response_format (schema goes in the prompt)', async () => {
  const calls: StructuredOutputStageLog[] = []
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    calls.push(params.responseFormatStage)
    if (calls.length <= 2) {
      throw new HttpStatusError(400, 'Bad Request', {
        bodyText: 'response_format is not supported.'
      })
    }
    return okResponse('{"summary":"ok"}')
  })
  const result = await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.deepEqual(calls, ['json_schema', 'json_object', 'none'])
  assert.equal(result.stage, 'none')
})

test('T3.32: success on the first rung makes only a single call', async () => {
  const attempt = mock.fn(async () => okResponse('{"summary":"ok"}'))
  await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.equal(attempt.mock.callCount(), 1)
})

test('T3.33: exactly 2 attempt calls for one degradation step (retry.ts already ruled out retrying the 400)', async () => {
  let calls = 0
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    calls++
    if (calls === 1) {
      assert.equal(params.responseFormatStage, 'json_schema')
      // Simulates retry.ts having already NOT retried this 400 internally —
      // completeStructured only ever sees it once per rung.
      throw new HttpStatusError(400, 'Bad Request', {
        bodyText: 'json_schema is not a supported response_format.'
      })
    }
    assert.equal(params.responseFormatStage, 'json_object')
    return okResponse('{"summary":"ok"}')
  })
  await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.equal(attempt.mock.callCount(), 2)
})

test('T3.34: a 400 mentioning max_tokens retries with max_completion_tokens', async () => {
  const paramsSeen: string[] = []
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    paramsSeen.push(params.maxOutputTokensParam)
    if (paramsSeen.length === 1) {
      throw new HttpStatusError(400, 'Bad Request', {
        bodyText: "Unsupported parameter: 'max_tokens' is not supported with this model."
      })
    }
    return okResponse('ok')
  })
  await completeStructured(baseRequest(), attempt)
  assert.deepEqual(paramsSeen, ['max_tokens', 'max_completion_tokens'])
})

test('T3.35: swappedMaxOutputTokensParam falls back from max_completion_tokens to max_tokens', () => {
  const result = swappedMaxOutputTokensParam(
    'max_completion_tokens',
    "Unsupported parameter: 'max_completion_tokens' is not supported with this model."
  )
  assert.equal(result, 'max_tokens')
  // And the reverse direction, for completeness alongside T3.34's full-ladder test:
  const reverse = swappedMaxOutputTokensParam('max_tokens', "Unsupported parameter: 'max_tokens'.")
  assert.equal(reverse, 'max_completion_tokens')
  // No mention of the current parameter name -> nothing to swap.
  assert.equal(swappedMaxOutputTokensParam('max_tokens', 'totally unrelated error'), null)
})

test('T3.36: the degradation stage actually used is available on the result (for logs/metrics)', async () => {
  let calls = 0
  const attempt = mock.fn(async () => {
    calls++
    if (calls === 1) {
      throw new HttpStatusError(400, 'Bad Request', { bodyText: 'response_format rejected' })
    }
    return okResponse('{"summary":"ok"}')
  })
  const result = await completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt)
  assert.equal(result.stage, 'json_object')
})

test('T3.37: a valid JSON response with no markdown parses directly', () => {
  const value = extractJson('{"summary":"looks good","findings":[]}')
  assert.deepEqual(value, { summary: 'looks good', findings: [] })
})

test('T3.38: a response wrapped in a ```json fenced block parses (FR-34)', () => {
  const text = '```json\n{"summary":"looks good"}\n```'
  const value = extractJson(text)
  assert.deepEqual(value, { summary: 'looks good' })
})

test('T3.39: a response with a text preamble before the JSON parses', () => {
  const text = 'Вот результат:\n{"summary":"looks good"}'
  const value = extractJson(text)
  assert.deepEqual(value, { summary: 'looks good' })
})

test('T3.40: a response with trailing text after the closing brace parses', () => {
  const text = '{"summary":"looks good"}\n\nLet me know if you need anything else!'
  const value = extractJson(text)
  assert.deepEqual(value, { summary: 'looks good' })
})

test('T3.41: fully invalid JSON throws a meaningful error, after exactly one retry with a stricter instruction', async () => {
  let calls = 0
  const strictFlags: boolean[] = []
  const attempt = mock.fn(async (params: StructuredAttemptParams) => {
    calls++
    strictFlags.push(params.strictJsonInstruction)
    return okResponse('This is not JSON at all, sorry!')
  })
  await assert.rejects(
    () => completeStructured(baseRequest({ responseSchema: SCHEMA }), attempt),
    (err: unknown) => err instanceof ProviderError
  )
  assert.equal(calls, 2)
  assert.deepEqual(strictFlags, [false, true])
})

test('T3.42: the JSON schema sent to the model never contains oneOf/allOf/$ref/pattern', () => {
  const dirty = {
    type: 'object',
    properties: {
      summary: { type: 'string', pattern: '^[A-Z]' },
      findings: {
        type: 'array',
        items: { oneOf: [{ $ref: '#/definitions/finding' }, { type: 'string' }] }
      }
    },
    required: ['summary'],
    allOf: [{ type: 'object' }]
  }
  const clean = sanitizeJsonSchema(dirty)
  const serialized = JSON.stringify(clean)
  assert.ok(!serialized.includes('oneOf'))
  assert.ok(!serialized.includes('allOf'))
  assert.ok(!serialized.includes('$ref'))
  assert.ok(!serialized.includes('pattern'))
  // The allowed shape survives.
  assert.equal((clean as { type: string }).type, 'object')
  assert.deepEqual((clean as { required: string[] }).required, ['summary'])
})

type StructuredOutputStageLog = 'json_schema' | 'json_object' | 'none'
