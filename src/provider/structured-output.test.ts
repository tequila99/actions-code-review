import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeStructured,
  extractJson,
  sanitizeJsonSchema,
  swappedMaxOutputTokensParam,
  toStrictJsonSchema,
  type StructuredAttemptParams
} from './structured-output.ts'
import { HttpStatusError } from './retry.ts'
import { ProviderError } from '../util/errors.ts'
import type { CompletionRequest, CompletionResponse, JsonSchema } from './types.ts'
import { FINDINGS_RESPONSE_SCHEMA } from '../engine/prompt/system.ts'

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

// ---------------------------------------------------------------------------
// TAD (issue #9): OpenAI strict-mode schema conversion.
// ---------------------------------------------------------------------------

test('TAD1: toStrictJsonSchema sets additionalProperties:false and required=all property keys', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } }
    },
    required: ['findings']
  }
  const strict = toStrictJsonSchema(schema)
  assert.equal(strict.additionalProperties, false)
  assert.deepEqual([...(strict.required as string[])].sort(), ['findings', 'summary'])
})

test('TAD2: a property absent from the original required list becomes a [T, "null"] union; an already-required one is untouched', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } }
    },
    required: ['findings']
  }
  const strict = toStrictJsonSchema(schema)
  const props = strict.properties as Record<string, JsonSchema>
  assert.deepEqual(props.summary?.type, ['string', 'null'])
  assert.equal(props.findings?.type, 'array')
})

test('TAD3: nested object schemas (inside array items) are strictified recursively', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            end_line: { type: 'integer' }
          },
          required: ['path']
        }
      }
    },
    required: ['findings']
  }
  const strict = toStrictJsonSchema(schema)
  const findingsProp = (strict.properties as Record<string, JsonSchema>).findings as JsonSchema
  const itemSchema = findingsProp.items as JsonSchema
  assert.equal(itemSchema.additionalProperties, false)
  assert.deepEqual([...(itemSchema.required as string[])].sort(), ['end_line', 'path'])
  const itemProps = itemSchema.properties as Record<string, JsonSchema>
  assert.deepEqual(itemProps.end_line?.type, ['integer', 'null'])
  assert.equal(itemProps.path?.type, 'string')
})

test('TAD4: a property whose type is already an array gets "null" appended without duplication', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      maybeNull: { type: ['string', 'null'] },
      optionalNum: { type: 'integer' }
    },
    required: []
  }
  const strict = toStrictJsonSchema(schema)
  const props = strict.properties as Record<string, JsonSchema>
  assert.deepEqual(props.maybeNull?.type, ['string', 'null'])
  assert.deepEqual(props.optionalNum?.type, ['integer', 'null'])
})

test('TAD5: sanitizeJsonSchema allows additionalProperties only when it is exactly false', () => {
  const withFalse = sanitizeJsonSchema({ type: 'object', properties: {}, additionalProperties: false })
  assert.equal(withFalse.additionalProperties, false)
  const withTrue = sanitizeJsonSchema({ type: 'object', properties: {}, additionalProperties: true })
  assert.equal('additionalProperties' in withTrue, false)
})

test('TAD6: sanitizeJsonSchema passes an array-form "type" (e.g. ["string","null"]) through unchanged', () => {
  const clean = sanitizeJsonSchema({ type: ['string', 'null'], description: 'x' })
  assert.deepEqual(clean.type, ['string', 'null'])
})

/** Recursively asserts every `type: 'object'` node satisfies OpenAI strict mode
 * (§9's #9): `additionalProperties: false` and `required` listing every key
 * in `properties`, at every nesting level (top-level object, array items, ...). */
function assertStrictModeCompliant (schema: unknown): void {
  if (schema === null || typeof schema !== 'object') return
  const obj = schema as Record<string, unknown>
  if (obj.type === 'object') {
    assert.equal(obj.additionalProperties, false, 'every object node must set additionalProperties:false')
    const props = (obj.properties ?? {}) as Record<string, unknown>
    assert.deepEqual(
      [...((obj.required as string[] | undefined) ?? [])].sort(),
      Object.keys(props).sort(),
      'required must list every property key'
    )
    for (const propSchema of Object.values(props)) assertStrictModeCompliant(propSchema)
  }
  if (obj.items) assertStrictModeCompliant(obj.items)
}

test('TAD7: FINDINGS_RESPONSE_SCHEMA, after sanitize+strictify, is valid per OpenAI strict-mode rules at every nesting level', () => {
  const strict = toStrictJsonSchema(sanitizeJsonSchema(FINDINGS_RESPONSE_SCHEMA))
  assertStrictModeCompliant(strict)
})
