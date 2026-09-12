import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterConfig } from './openai-compatible.ts'
import {
  withMockedFetch,
  withMockedFetchCounting,
  jsonResponse,
  textResponse,
  type FetchHandler
} from '../../test/helpers/fetch-mock.ts'
import type { CompletionRequest } from './types.ts'
import { registerSecret } from '../util/secrets.ts'

const fixturePath = fileURLToPath(
  new URL('../../test/fixtures/provider/chat-completion-success.json', import.meta.url)
)
const SUCCESS_FIXTURE: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))

function createAdapter (
  overrides: Partial<OpenAICompatibleAdapterConfig> = {}
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-api-key-value',
    model: 'gpt-4o-mini',
    headers: {},
    requestTimeoutMs: 5000,
    // Fast/no-op retry settings: none of these tests want real delays, and
    // most error scenarios are non-retryable anyway (see retry.test.ts for
    // retry-policy coverage in isolation).
    retry: { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
    ...overrides
  })
}

function baseRequest (overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'You are a reviewer.',
    messages: [{ role: 'user', content: 'Review this diff.' }],
    maxOutputTokens: 500,
    signal: new AbortController().signal,
    ...overrides
  }
}

test('T3.1: a successful response is translated to {text, toolCalls: [], usage, finishReason}', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse(SUCCESS_FIXTURE),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.text, 'Looks good overall, one nit below.')
      assert.deepEqual(res.toolCalls, [])
      assert.deepEqual(res.usage, { promptTokens: 123, completionTokens: 17, estimated: false })
      assert.equal(res.finishReason, 'stop')
    }
  )
})

test('T3.2: request URL is POST {base_url}/chat/completions with no double slashes', async () => {
  const adapter = createAdapter({ baseUrl: 'https://api.example.com/v1/' })
  let seenUrl: string | undefined
  let seenMethod: string | undefined
  await withMockedFetch(
    (url, init) => {
      seenUrl = String(url)
      seenMethod = init?.method
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal(seenUrl, 'https://api.example.com/v1/chat/completions')
  assert.equal(seenMethod, 'POST')
})

test('T3.3: headers include Authorization: Bearer <key> and Content-Type: application/json', async () => {
  const adapter = createAdapter({ apiKey: 'my-secret-key-abc' })
  let seenHeaders: Headers | undefined
  await withMockedFetch(
    (_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal(seenHeaders?.get('authorization'), 'Bearer my-secret-key-abc')
  assert.equal(seenHeaders?.get('content-type'), 'application/json')
})

test('T3.4: custom api_headers are present on the request', async () => {
  const adapter = createAdapter({ headers: { 'X-Gateway-Route': 'review' } })
  let seenHeaders: Headers | undefined
  await withMockedFetch(
    (_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal(seenHeaders?.get('x-gateway-route'), 'review')
})

test('T3.5: a custom Authorization header overrides the default Bearer header', async () => {
  const adapter = createAdapter({
    apiKey: 'should-not-be-used',
    headers: { Authorization: 'Custom xyz' }
  })
  let seenHeaders: Headers | undefined
  await withMockedFetch(
    (_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal(seenHeaders?.get('authorization'), 'Custom xyz')
})

test('T3.6: an empty api_key means no Authorization header is sent at all', async () => {
  const adapter = createAdapter({ apiKey: '' })
  let seenHeaders: Headers | undefined
  await withMockedFetch(
    (_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal(seenHeaders?.has('authorization'), false)
})

test('T3.7: an unset temperature is absent from the request body', async () => {
  const adapter = createAdapter()
  let seenBody: Record<string, unknown> | undefined
  await withMockedFetch(
    (_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest())
  )
  assert.equal('temperature' in (seenBody ?? {}), false)
})

test('T3.7b: a set temperature IS present in the request body', async () => {
  const adapter = createAdapter()
  let seenBody: Record<string, unknown> | undefined
  await withMockedFetch(
    (_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest({ temperature: 0.2 }))
  )
  assert.equal(seenBody?.temperature, 0.2)
})

test('T3.8: tool_calls in the response are parsed into toolCalls[] with id/name/parsed arguments', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"foo"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(
        baseRequest({ tools: [{ name: 'search', description: 'x', parameters: {} }] })
      )
      assert.equal(res.toolCalls.length, 1)
      assert.equal(res.toolCalls[0]?.id, 'call_1')
      assert.equal(res.toolCalls[0]?.name, 'search')
      assert.deepEqual(res.toolCalls[0]?.arguments, { query: 'foo' })
    }
  )
})

test('T3.9: invalid JSON in tool_calls.arguments does not throw; the call is marked with an error', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{not valid' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(
        baseRequest({ tools: [{ name: 'search', description: 'x', parameters: {} }] })
      )
      assert.equal(res.toolCalls.length, 1)
      assert.equal(res.toolCalls[0]?.arguments, undefined)
      assert.ok(
        res.toolCalls[0]?.argumentsError?.length && res.toolCalls[0].argumentsError.length > 0
      )
    }
  )
})

test('T3.10: a response with no usage field gets an estimated usage (FR-24)', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.usage.estimated, true)
      assert.ok(res.usage.promptTokens > 0)
      assert.ok(res.usage.completionTokens >= 0)
    }
  )
})

test('T3.11: a response with no finish_reason defaults without throwing (R-6)', async () => {
  const adapter = createAdapter()
  const response = { choices: [{ message: { role: 'assistant', content: 'ok' } }] }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(typeof res.finishReason, 'string')
      assert.ok(res.finishReason.length > 0)
    }
  )
})

test('T3.12: an empty choices[] array is a meaningful ProviderError, not a TypeError', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse({ choices: [] }),
    () =>
      assert.rejects(
        () => adapter.complete(baseRequest()),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.notEqual(err.constructor.name, 'TypeError')
          assert.match(err.message, /choices/i)
          return true
        }
      )
  )
})

test('TR.1: an empty choices[] error includes a truncated, redacted snippet of the raw body', async () => {
  const adapter = createAdapter()
  registerSecret('sekret-value')
  await withMockedFetch(
    () => jsonResponse({ choices: [], promptFeedback: { blockReason: 'SAFETY: sekret-value' } }),
    () =>
      assert.rejects(
        () => adapter.complete(baseRequest()),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /choices/i)
          assert.match(err.message, /promptFeedback/)
          assert.match(err.message, /blockReason/)
          assert.doesNotMatch(err.message, /sekret-value/)
          return true
        }
      )
  )
})

test('T3.13: a non-JSON body (HTML gateway page) is a meaningful, truncated, redacted error', async () => {
  const adapter = createAdapter()
  const html = `<html><body>Gateway timeout, secret=${'x'.repeat(600)}</body></html>`
  await withMockedFetch(
    () => textResponse(html, { status: 200 }),
    () =>
      assert.rejects(
        () => adapter.complete(baseRequest()),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.length < html.length, 'error message must be truncated')
          assert.ok(err.message.includes('truncated'))
          return true
        }
      )
  )
})

test('T3.14/T3.15: HTTP 401 is a ProviderError about an invalid api_key, with the key redacted', async () => {
  const secretKey = 'super-secret-key-should-not-leak'
  registerSecret(secretKey)
  const adapter = createAdapter({ apiKey: secretKey })
  await withMockedFetch(
    () => textResponse(`{"error":{"message":"invalid api key: ${secretKey}"}}`, { status: 401 }),
    () =>
      assert.rejects(
        () => adapter.complete(baseRequest()),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /api_key/i)
          assert.equal(
            err.message.includes(secretKey),
            false,
            'the raw key must never appear in the error message'
          )
          return true
        }
      )
  )
})

test('T3.16: the request signal is propagated to fetch and reflects the caller AbortSignal', async () => {
  const adapter = createAdapter()
  let seenSignal: AbortSignal | undefined
  const controller = new AbortController()
  await withMockedFetch(
    (_url, init) => {
      seenSignal = init?.signal as AbortSignal | undefined
      return jsonResponse(SUCCESS_FIXTURE)
    },
    () => adapter.complete(baseRequest({ signal: controller.signal }))
  )
  assert.ok(seenSignal instanceof AbortSignal)
  assert.equal(seenSignal?.aborted, false)
  controller.abort(new Error('caller cancelled'))
  assert.equal(seenSignal?.aborted, true)
})

test('T3.17: request_timeout_ms aborts a hanging request with a timeout error', async () => {
  const adapter = createAdapter({ requestTimeoutMs: 20 })
  const hangingFetch: FetchHandler = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      })
    })
  await withMockedFetch(hangingFetch, () => assert.rejects(() => adapter.complete(baseRequest())))
})

test('an assistant message carrying toolCalls is serialized to wire tool_calls (stage 7, FR-25 multi-turn tool loop)', async () => {
  const adapter = createAdapter()
  const seenBodies: unknown[] = []
  await withMockedFetch(
    (_url, init) => {
      seenBodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
      })
    },
    () =>
      adapter.complete(
        baseRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]
            },
            { role: 'tool', content: 'file content', toolCallId: 'call_1', name: 'read_file' }
          ]
        })
      )
  )
  const body = seenBodies[0] as { messages: Array<Record<string, unknown>> }
  const assistantMessage = body.messages.find((m) => m.role === 'assistant')!
  assert.deepEqual(assistantMessage.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }
  ])
  const toolMessage = body.messages.find((m) => m.role === 'tool')!
  assert.equal(toolMessage.tool_call_id, 'call_1')
  assert.equal(toolMessage.name, 'read_file')
  assert.equal(toolMessage.content, 'file content')
})

test('T3.18: a tool call returned as text in content (vLLM without --enable-auto-tool-choice) is detected', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '{"name":"search","arguments":{"query":"foo"}}',
          tool_calls: []
        },
        finish_reason: 'stop'
      }
    ]
  }
  await withMockedFetch(
    () => jsonResponse(response),
    () =>
      assert.rejects(
        () =>
          adapter.complete(
            baseRequest({ tools: [{ name: 'search', description: 'x', parameters: {} }] })
          ),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          const hint = (err as { hint?: string }).hint ?? ''
          assert.match(err.message.toLowerCase(), /tool/)
          assert.match(hint, /--enable-auto-tool-choice/)
          assert.match(hint, /--tool-call-parser/)
          return true
        }
      )
  )
})

test('TA.1: usage.cost (OpenRouter extension) present -> costUsd is set on CompletionResponse.usage', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 19, completion_tokens: 5, total_tokens: 24, cost: 0.00002654 }
  }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.deepEqual(res.usage, {
        promptTokens: 19,
        completionTokens: 5,
        estimated: false,
        costUsd: 0.00002654
      })
    }
  )
})

test('TA.2: usage.cost absent -> costUsd is undefined, rest of usage unaffected', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse(SUCCESS_FIXTURE),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.usage.costUsd, undefined)
      assert.deepEqual(res.usage, { promptTokens: 123, completionTokens: 17, estimated: false })
    }
  )
})

test('TA.3: usage.cost present but not a number -> ignored as absent, no exception', async () => {
  const adapter = createAdapter()
  const response = {
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 19, completion_tokens: 5, cost: 'not-a-number' }
  }
  await withMockedFetch(
    () => jsonResponse(response),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.usage.costUsd, undefined)
      assert.deepEqual(res.usage, { promptTokens: 19, completionTokens: 5, estimated: false })
    }
  )
})

test('capabilities(): resolves to a sane shape on a healthy provider (not part of T3.x, smoke coverage)', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
    async () => {
      const caps = await adapter.capabilities()
      assert.deepEqual(caps, { toolCalling: true, jsonSchema: true, jsonObject: true })
    }
  )
})

test('capabilities(): degrades to all-false on a failing provider (not part of T3.x, smoke coverage)', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => textResponse('nope', { status: 500 }),
    async () => {
      const caps = await adapter.capabilities()
      assert.deepEqual(caps, { toolCalling: false, jsonSchema: false, jsonObject: false })
    }
  )
})

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok']
} as const

function systemContentOf (body: unknown): string {
  const messages = (body as { messages: Array<{ role: string; content: string }> }).messages
  const system = messages.find((m) => m.role === 'system')
  if (!system) throw new Error('no system message in request body')
  return system.content
}

test('TD.1: with a responseSchema, the json_schema-stage (first attempt) system message mentions "json" (Azure/OpenRouter response_format validation compatibility)', async () => {
  const adapter = createAdapter()
  const seenBodies: unknown[] = []
  await withMockedFetch(
    (_url, init) => {
      seenBodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }]
      })
    },
    () => adapter.complete(baseRequest({ responseSchema: SCHEMA }))
  )
  assert.equal(seenBodies.length, 1)
  assert.match(systemContentOf(seenBodies[0]).toLowerCase(), /json/)
})

test('TD.2: with a responseSchema, the json_object-stage (after a json_schema 400 fallback) system message spells out the schema in text (response_format:json_object carries no schema over the wire, unlike json_schema)', async () => {
  const adapter = createAdapter()
  const seenBodies: unknown[] = []
  await withMockedFetchCounting(
    (_url, init) => {
      seenBodies.push(JSON.parse(String(init?.body)))
      if (seenBodies.length === 1) {
        return textResponse(
          '{"error":{"message":"response_format.json_schema is not supported"}}',
          {
            status: 400
          }
        )
      }
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }]
      })
    },
    () => adapter.complete(baseRequest({ responseSchema: SCHEMA }))
  )
  assert.equal(seenBodies.length, 2)
  assert.equal(
    (seenBodies[0] as { response_format?: { type: string } }).response_format?.type,
    'json_schema'
  )
  assert.equal(
    (seenBodies[1] as { response_format?: { type: string } }).response_format?.type,
    'json_object'
  )
  // The json_schema-stage attempt doesn't need the schema spelled out in text
  // (it's passed structurally via response_format.json_schema.schema).
  assert.doesNotMatch(systemContentOf(seenBodies[0]), /"ok"/)
  // The json_object-stage attempt DOES need it spelled out — response_format
  // type "json_object" carries no schema of its own, so without this the
  // model has no way to know the expected field names at all. Observed in
  // production: a model left to guess invented plausible-looking field names
  // ("file"/"summary" instead of "path"/"message").
  assert.match(systemContentOf(seenBodies[1]), /"ok"/)
})
