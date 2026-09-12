import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webSearch, WEB_SEARCH_SPEC, createWebSearchCallBudget } from './web-search.ts'
import { registerSecret } from '../../util/secrets.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'
import { withMockedFetch, withMockedFetchCounting, jsonResponse, textResponse } from '../../../test/helpers/fetch-mock.ts'

function openRouterCompletion (content: string, annotations?: unknown[]): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          ...(annotations ? { annotations } : {})
        }
      }
    ]
  }
}

test('TT.34: WEB_SEARCH_SPEC requires a non-empty string query parameter', () => {
  assert.equal(WEB_SEARCH_SPEC.name, 'web_search')
  assert.deepEqual(WEB_SEARCH_SPEC.parameters.required, ['query'])
  const properties = WEB_SEARCH_SPEC.parameters.properties as Record<string, unknown>
  assert.ok('query' in properties)
})

test('TU.3: WEB_SEARCH_SPEC tells the model not to search for itself or unrelated topics — ' +
  'confirmed on a real production trace (GPT-5.6-terra via OpenRouter) where a run spent one of ' +
  'its 6 allotted calls looking up its own OpenRouter model listing instead of anything PR-relevant', () => {
  assert.match(WEB_SEARCH_SPEC.description, /not.*(itself|yourself|this (tool|model))/i)
})

test('TT.35: a successful call wraps the answer text in <untrusted_content>', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => jsonResponse(openRouterCompletion('The answer is 42.')),
    () => webSearch({ query: 'what is the answer' }, ctx)
  )
  assert.equal(result.isError, false)
  assert.match(result.content, /^<untrusted_content>/)
  assert.match(result.content, /<\/untrusted_content>$/)
  assert.match(result.content, /The answer is 42\./)
})

test('TT.36: url_citation annotations are appended as a Sources list', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () =>
      jsonResponse(
        openRouterCompletion('Answer text.', [
          { type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'Example A' } },
          { type: 'url_citation', url_citation: { url: 'https://example.com/b' } }
        ])
      ),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, false)
  assert.match(result.content, /Sources:/)
  assert.match(result.content, /- Example A: https:\/\/example\.com\/a/)
  assert.match(result.content, /- https:\/\/example\.com\/b/)
})

test('TT.37: malformed/absent annotations are silently ignored, not an error', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => jsonResponse(openRouterCompletion('Answer text.', [{ type: 'other' }, 'not-an-object'])),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, false)
  assert.equal(result.content.includes('Sources:'), false)
})

test('TT.38: empty query is rejected without calling fetch', async () => {
  const ctx = makeToolContext('/repo')
  await withMockedFetchCounting(
    () => jsonResponse(openRouterCompletion('unused')),
    async (callCount) => {
      const result = await webSearch({ query: '   ' }, ctx)
      assert.equal(result.isError, true)
      assert.match(result.content, /non-empty string/)
      assert.equal(callCount(), 0)
    }
  )
})

test('TT.39: a non-OpenRouter base URL fails without calling fetch', async () => {
  const ctx = makeToolContext('/repo', {
    webSearch: {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'test-model',
      maxCalls: 4,
      extraHeaders: {},
      budget: createWebSearchCallBudget(4)
    }
  })
  await withMockedFetchCounting(
    () => jsonResponse(openRouterCompletion('unused')),
    async (callCount) => {
      const result = await webSearch({ query: 'q' }, ctx)
      assert.equal(result.isError, true)
      assert.match(result.content, /OpenRouter/)
      assert.equal(callCount(), 0)
    }
  )
})

test('TT.40: HTTP non-200 responses return an error result, not a throw', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => textResponse('Internal Server Error', { status: 500 }),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /HTTP 500/)
})

test('TT.41: a non-JSON body returns an error result, not a throw', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => textResponse('<html>not json</html>', { status: 200 }),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /non-JSON/)
})

test('TT.42: a thrown/network fetch error returns an error result, not a throw', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND openrouter.ai')
    },
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /request error/)
})

test('TT.43: empty message content in a 200 response is an error, not a silent success', async () => {
  const ctx = makeToolContext('/repo')
  const result = await withMockedFetch(
    () => jsonResponse(openRouterCompletion('   ')),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /empty response content/)
})

test('TT.44: the call budget is enforced independently of agent_max_tool_calls', async () => {
  const budget = createWebSearchCallBudget(1)
  const ctx = makeToolContext('/repo', {
    webSearch: {
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      maxCalls: 1,
      extraHeaders: {},
      budget
    }
  })
  await withMockedFetchCounting(
    () => jsonResponse(openRouterCompletion('first answer')),
    async (callCount) => {
      const first = await webSearch({ query: 'q1' }, ctx)
      assert.equal(first.isError, false)
      assert.equal(callCount(), 1)

      const second = await webSearch({ query: 'q2' }, ctx)
      assert.equal(second.isError, true)
      assert.match(second.content, /call limit/)
      assert.equal(callCount(), 1)
    }
  )
})

test('TT.45: the request is a POST to <baseUrl>/chat/completions with the OpenRouter web_search server tool', async () => {
  const ctx = makeToolContext('/repo')
  let capturedUrl: string | undefined
  let capturedInit: RequestInit | undefined
  await withMockedFetch(
    (url, init) => {
      capturedUrl = String(url)
      capturedInit = init
      return jsonResponse(openRouterCompletion('answer'))
    },
    () => webSearch({ query: 'some query' }, ctx)
  )
  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(capturedInit?.method, 'POST')
  const headers = capturedInit?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sk-test-key')
  const body = JSON.parse(capturedInit?.body as string)
  assert.equal(body.model, 'test-model')
  assert.deepEqual(body.tools, [{ type: 'openrouter:web_search' }])
  assert.equal(typeof body.max_tokens, 'number')
  assert.equal(body.messages[0].content, 'some query')
})

test('TT.50: a malformed base URL is treated as non-OpenRouter, not a throw', async () => {
  const ctx = makeToolContext('/repo', {
    webSearch: {
      apiKey: 'sk-test',
      baseUrl: 'not-a-valid-url',
      model: 'test-model',
      maxCalls: 4,
      extraHeaders: {},
      budget: createWebSearchCallBudget(4)
    }
  })
  const result = await webSearch({ query: 'q' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /OpenRouter/)
})

test('TT.51: a long result is truncated to toolOutputMaxBytes', async () => {
  const ctx = makeToolContext('/repo', { toolOutputMaxBytes: 100 })
  const result = await withMockedFetch(
    () => jsonResponse(openRouterCompletion('x'.repeat(500))),
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(result.isError, false)
  assert.match(result.content, /truncated, output exceeded 100 bytes/)
})

test('TT.52: extraHeaders override the default Content-Type/Authorization case-insensitively and pass through custom ones', async () => {
  const ctx = makeToolContext('/repo', {
    webSearch: {
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      maxCalls: 4,
      extraHeaders: { authorization: 'Bearer overridden', 'X-Custom': 'yes' },
      budget: createWebSearchCallBudget(4)
    }
  })
  let capturedHeaders: Record<string, string> | undefined
  await withMockedFetch(
    (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>
      return jsonResponse(openRouterCompletion('answer'))
    },
    () => webSearch({ query: 'q' }, ctx)
  )
  assert.equal(capturedHeaders!.authorization, 'Bearer overridden')
  assert.equal('Authorization' in capturedHeaders!, false)
  assert.equal(capturedHeaders!['X-Custom'], 'yes')
})

test('TT.46: the outgoing query is passed through redact()', async () => {
  registerSecret('totallySecretWebSearchValue123')
  const ctx = makeToolContext('/repo')
  let capturedBody: string | undefined
  await withMockedFetch(
    (_url, init) => {
      capturedBody = init?.body as string
      return jsonResponse(openRouterCompletion('answer'))
    },
    () => webSearch({ query: 'contains totallySecretWebSearchValue123 inline' }, ctx)
  )
  const body = JSON.parse(capturedBody!)
  assert.equal(body.messages[0].content.includes('totallySecretWebSearchValue123'), false)
  assert.match(body.messages[0].content, /\*\*\*/)
})
