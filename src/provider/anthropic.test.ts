import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AnthropicAdapter, type AnthropicAdapterConfig } from './anthropic.ts'
import {
  withMockedFetch,
  withMockedFetchCounting,
  jsonResponse,
  textResponse,
  type FetchHandler
} from '../../test/helpers/fetch-mock.ts'
import type { ChatMessage, CompletionRequest } from './types.ts'

function fixture (name: string): unknown {
  const p = fileURLToPath(new URL(`../../test/fixtures/provider/${name}`, import.meta.url))
  return JSON.parse(readFileSync(p, 'utf8'))
}

const SUCCESS_FIXTURE = fixture('anthropic-message-success.json')
const TOOL_USE_FIXTURE = fixture('anthropic-tool-use.json')

function createAdapter (overrides: Partial<AnthropicAdapterConfig> = {}): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-anthropic-key',
    model: 'claude-sonnet-5',
    headers: {},
    requestTimeoutMs: 5000,
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

async function captureRequest (
  handler: FetchHandler,
  req: CompletionRequest,
  overrides: Partial<AnthropicAdapterConfig> = {}
): Promise<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> {
  let seenUrl = ''
  let seenInit: RequestInit | undefined
  await withMockedFetch(
    (url, init) => {
      seenUrl = String(url)
      seenInit = init
      return handler(url, init)
    },
    () => createAdapter(overrides).complete(req)
  )
  const body = JSON.parse(String(seenInit?.body ?? '{}')) as Record<string, unknown>
  return { url: seenUrl, init: seenInit, body }
}

test('T9.1: request is POST {base}/v1/messages with x-api-key and anthropic-version headers', async () => {
  const { url, init } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest())
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init?.method, 'POST')
  const headers = new Headers(init?.headers)
  assert.equal(headers.get('x-api-key'), 'test-anthropic-key')
  assert.equal(headers.get('anthropic-version'), '2023-06-01')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('T9.2: system is a separate top-level field, not inside messages', async () => {
  const { body } = await captureRequest(
    () => jsonResponse(SUCCESS_FIXTURE),
    baseRequest({ system: 'System prompt text.' })
  )
  assert.equal(body.system, 'System prompt text.')
  const messages = body.messages as Array<Record<string, unknown>>
  assert.ok(messages.every((m) => m.role !== 'system'))
})

test('T9.3: ToolSpec is converted to {name, description, input_schema}', async () => {
  const { body } = await captureRequest(
    () => jsonResponse(SUCCESS_FIXTURE),
    baseRequest({
      tools: [
        {
          name: 'get_diff',
          description: 'Get the PR diff.',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      ]
    })
  )
  const tools = body.tools as Array<Record<string, unknown>>
  assert.deepEqual(tools, [
    {
      name: 'get_diff',
      description: 'Get the PR diff.',
      input_schema: { type: 'object', properties: {}, required: [] }
    }
  ])
})

test('T9.4a: a text-only response is translated to {text, toolCalls: [], usage, finishReason}', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse(SUCCESS_FIXTURE),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.text, 'Looks good overall, one nit below.')
      assert.deepEqual(res.toolCalls, [])
      assert.equal(res.finishReason, 'end_turn')
      assert.deepEqual(res.usage, { promptTokens: 123, completionTokens: 17, estimated: false })
    }
  )
})

test('T9.4b: a stop_reason:"tool_use" response with tool_use blocks is parsed into toolCalls[]', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse(TOOL_USE_FIXTURE),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.text, 'Let me check the file.')
      assert.deepEqual(res.toolCalls, [
        { id: 'toolu_fixture_1', name: 'read_file', arguments: { path: 'src/index.ts' } }
      ])
      assert.equal(res.finishReason, 'tool_use')
    }
  )
})

test('T9.4c: an assistant message carrying toolCalls is serialized to a tool_use content block', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Review this diff.' },
    {
      role: 'assistant',
      content: 'Checking the file.',
      toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }]
    },
    { role: 'tool', content: 'file contents', toolCallId: 'toolu_1', name: 'read_file' }
  ]
  const { body } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest({ messages }))
  const wireMessages = body.messages as Array<Record<string, unknown>>
  const assistantMsg = wireMessages[1]
  assert.equal(assistantMsg?.role, 'assistant')
  const assistantContent = assistantMsg?.content as Array<Record<string, unknown>>
  assert.deepEqual(assistantContent, [
    { type: 'text', text: 'Checking the file.' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }
  ])
})

test('T9.5: a tool-result ChatMessage becomes a role:"user" message with a tool_result block', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Review this diff.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: 'file contents here', toolCallId: 'toolu_1', name: 'read_file' }
  ]
  const { body } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest({ messages }))
  const wireMessages = body.messages as Array<Record<string, unknown>>
  const toolResultMsg = wireMessages[2]
  assert.equal(toolResultMsg?.role, 'user')
  assert.deepEqual(toolResultMsg?.content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents here' }
  ])
})

test('T9.5b: consecutive tool-result ChatMessages (multiple tool calls in one turn) merge into one user message', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Review this diff.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'toolu_1', name: 'read_file', arguments: {} },
        { id: 'toolu_2', name: 'grep', arguments: {} }
      ]
    },
    { role: 'tool', content: 'file A', toolCallId: 'toolu_1', name: 'read_file' },
    { role: 'tool', content: 'grep results', toolCallId: 'toolu_2', name: 'grep' }
  ]
  const { body } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest({ messages }))
  const wireMessages = body.messages as Array<Record<string, unknown>>
  assert.equal(wireMessages.length, 3)
  const merged = wireMessages[2]
  assert.equal(merged?.role, 'user')
  assert.deepEqual(merged?.content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file A' },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'grep results' }
  ])
})

test('T9.6: a responseSchema request sends output_config: {format: {type: "json_schema", schema}}', async () => {
  const { body } = await captureRequest(
    () => jsonResponse(SUCCESS_FIXTURE),
    baseRequest({
      responseSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      }
    })
  )
  assert.deepEqual(body.output_config, {
    format: {
      type: 'json_schema',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    }
  })
  assert.equal(body.output_format, undefined)
})

test('T9.7: structured output does not use assistant-prefill (no trailing assistant "{" message)', async () => {
  const { body } = await captureRequest(
    () => jsonResponse(SUCCESS_FIXTURE),
    baseRequest({
      responseSchema: { type: 'object', properties: {}, required: [] }
    })
  )
  const messages = body.messages as Array<Record<string, unknown>>
  const last = messages[messages.length - 1]
  assert.notEqual(last?.role, 'assistant')
})

test('T9.8: no budget_tokens and no legacy thinking config is ever sent', async () => {
  const { body } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest())
  const bodyText = JSON.stringify(body)
  assert.ok(!bodyText.includes('budget_tokens'))
  assert.equal(body.thinking, undefined)
})

test('T9.9: sampling parameters (temperature/top_p/top_k) are never sent', async () => {
  const { body } = await captureRequest(
    () => jsonResponse(SUCCESS_FIXTURE),
    baseRequest({ temperature: 0.7 })
  )
  assert.equal(body.temperature, undefined)
  assert.equal(body.top_p, undefined)
  assert.equal(body.top_k, undefined)
})

test('T9.10a: usage.input_tokens/output_tokens map to promptTokens/completionTokens', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () => jsonResponse(SUCCESS_FIXTURE),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.deepEqual(res.usage, { promptTokens: 123, completionTokens: 17, estimated: false })
    }
  )
})

test('T9.10b: cache_creation_input_tokens/cache_read_input_tokens are folded into promptTokens when present', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () =>
      jsonResponse({
        ...(SUCCESS_FIXTURE as Record<string, unknown>),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 5
        }
      }),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.deepEqual(res.usage, { promptTokens: 135, completionTokens: 20, estimated: false })
    }
  )
})

test('T9.11: stop_reason:"max_tokens" is reflected as finishReason:"max_tokens"', async () => {
  const adapter = createAdapter()
  await withMockedFetch(
    () =>
      jsonResponse({ ...(SUCCESS_FIXTURE as Record<string, unknown>), stop_reason: 'max_tokens' }),
    async () => {
      const res = await adapter.complete(baseRequest())
      assert.equal(res.finishReason, 'max_tokens')
    }
  )
})

test('T9.12: HTTP 429 with retry-after is retried via retry.ts', async () => {
  await withMockedFetchCounting(
    (() => {
      let call = 0
      return () => {
        call++
        if (call === 1) return textResponse('rate limited', { status: 429, headers: { 'retry-after': '0' } })
        return jsonResponse(SUCCESS_FIXTURE)
      }
    })(),
    async (callCount) => {
      const res = await createAdapter().complete(baseRequest())
      assert.equal(res.text, 'Looks good overall, one nit below.')
      assert.equal(callCount(), 2)
    }
  )
})

test('T9.13: HTTP 529 overloaded_error is retried', async () => {
  await withMockedFetchCounting(
    (() => {
      let call = 0
      return () => {
        call++
        if (call === 1) {
          return jsonResponse(
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            { status: 529 }
          )
        }
        return jsonResponse(SUCCESS_FIXTURE)
      }
    })(),
    async (callCount) => {
      const res = await createAdapter().complete(baseRequest())
      assert.equal(res.text, 'Looks good overall, one nit below.')
      assert.equal(callCount(), 2)
    }
  )
})

test('T9.14: capabilities() reports native tool calling and structured-output support', async () => {
  const adapter = createAdapter()
  const caps = await adapter.capabilities()
  assert.deepEqual(caps, { toolCalling: true, jsonSchema: true, jsonObject: true })
})

test('HTTP 401 is a meaningful, redacted ProviderError about an invalid api_key', async () => {
  await withMockedFetch(
    () => textResponse('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 }),
    async () => {
      await assert.rejects(createAdapter({ apiKey: 'super-secret-anthropic-key' }).complete(baseRequest()), (err: Error) => {
        assert.match(err.message, /invalid api_key/i)
        assert.ok(!err.message.includes('super-secret-anthropic-key'))
        return true
      })
    }
  )
})

// #26: an empty apiKey must not produce an empty/garbage x-api-key header —
// some gateways reject an empty header value outright. A custom header
// supplied via `api.headers` (Authorization or x-api-key) still wins.

test('TAE1: an empty apiKey sends no x-api-key header at all when no custom headers are set', async () => {
  const { init } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest(), { apiKey: '' })
  const headers = new Headers(init?.headers)
  assert.equal(headers.has('x-api-key'), false)
})

test('TAE2: a custom x-api-key header wins over an empty apiKey', async () => {
  const { init } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest(), {
    apiKey: '',
    headers: { 'x-api-key': 'custom-key-from-config' }
  })
  const headers = new Headers(init?.headers)
  assert.equal(headers.get('x-api-key'), 'custom-key-from-config')
})

test('TAE3: a custom Authorization header is sent alongside a suppressed empty x-api-key', async () => {
  const { init } = await captureRequest(() => jsonResponse(SUCCESS_FIXTURE), baseRequest(), {
    apiKey: '',
    headers: { Authorization: 'Bearer gateway-token' }
  })
  const headers = new Headers(init?.headers)
  assert.equal(headers.has('x-api-key'), false)
  assert.equal(headers.get('authorization'), 'Bearer gateway-token')
})
