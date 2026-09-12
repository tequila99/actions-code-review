/**
 * T9.23: contract test across every implemented `ProviderAdapter` — the
 * same logical request must produce a structurally consistent
 * `CompletionResponse` regardless of which flavor produced it. "Structurally
 * consistent" means the TS shape and field *types* line up (every engine
 * downstream — `DiffEngine`/`AgentEngine` — only ever depends on that
 * shape, never on a specific flavor's own vocabulary for e.g.
 * `finishReason`, which is intentionally NOT normalized across adapters,
 * see `agent-engine.ts`: nothing branches on a specific `finishReason`
 * string value).
 *
 * Scope note (stage 9a, see IMPLEMENTATION_PLAN.md "Этап 9" 9a/9b split):
 * this covers `openai` + `anthropic` only. `gemini` joins this same test
 * in stage 9b, once `gemini.ts` exists.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicAdapter } from './anthropic.ts'
import { OpenAICompatibleAdapter } from './openai-compatible.ts'
import { withMockedFetch, jsonResponse } from '../../test/helpers/fetch-mock.ts'
import type { CompletionRequest, ProviderAdapter, ToolSpec } from './types.ts'

const READ_FILE_TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Read a file from the repository.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}

function baseRequest (overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'You are a reviewer.',
    messages: [{ role: 'user', content: 'Review this diff.' }],
    tools: [READ_FILE_TOOL],
    maxOutputTokens: 500,
    signal: new AbortController().signal,
    ...overrides
  }
}

interface Scenario {
  flavor: 'openai' | 'anthropic'
  adapter: ProviderAdapter
  textFixture: unknown
  toolCallFixture: unknown
}

function scenarios (): Scenario[] {
  return [
    {
      flavor: 'openai',
      adapter: new OpenAICompatibleAdapter({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        headers: {},
        requestTimeoutMs: 5000,
        retry: { maxAttempts: 1 }
      }),
      textFixture: {
        choices: [{ message: { role: 'assistant', content: 'Looks good.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      },
      toolCallFixture: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      }
    },
    {
      flavor: 'anthropic',
      adapter: new AnthropicAdapter({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-5',
        headers: {},
        requestTimeoutMs: 5000,
        retry: { maxAttempts: 1 }
      }),
      textFixture: {
        content: [{ type: 'text', text: 'Looks good.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 }
      },
      toolCallFixture: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }
  ]
}

function assertWellFormedResponse (res: Awaited<ReturnType<ProviderAdapter['complete']>>): void {
  assert.ok(res.text === null || typeof res.text === 'string')
  assert.ok(Array.isArray(res.toolCalls))
  assert.equal(typeof res.usage.promptTokens, 'number')
  assert.equal(typeof res.usage.completionTokens, 'number')
  assert.equal(typeof res.usage.estimated, 'boolean')
  assert.equal(typeof res.finishReason, 'string')
  assert.ok(res.finishReason.length > 0)
  assert.notEqual(res.raw, undefined)
}

for (const scenario of scenarios()) {
  test(`T9.23: ${scenario.flavor} adapter — plain-text response is structurally well-formed`, async () => {
    await withMockedFetch(
      () => jsonResponse(scenario.textFixture),
      async () => {
        const res = await scenario.adapter.complete(baseRequest())
        assertWellFormedResponse(res)
        assert.equal(res.text, 'Looks good.')
        assert.deepEqual(res.toolCalls, [])
      }
    )
  })

  test(`T9.23: ${scenario.flavor} adapter — tool-call response is structurally well-formed`, async () => {
    await withMockedFetch(
      () => jsonResponse(scenario.toolCallFixture),
      async () => {
        const res = await scenario.adapter.complete(baseRequest())
        assertWellFormedResponse(res)
        assert.equal(res.toolCalls.length, 1)
        assert.equal(res.toolCalls[0]?.name, 'read_file')
        assert.deepEqual(res.toolCalls[0]?.arguments, { path: 'a.ts' })
      }
    )
  })

  test(`T9.23: ${scenario.flavor} adapter — capabilities() resolves to a well-formed shape`, async () => {
    // openai's capabilities() makes a live probe call via complete(); anthropic's is static
    // (see anthropic.ts) — mock fetch either way so neither ever touches the real network.
    await withMockedFetch(
      () => jsonResponse(scenario.textFixture),
      async () => {
        const caps = await scenario.adapter.capabilities()
        assert.equal(typeof caps.toolCalling, 'boolean')
        assert.equal(typeof caps.jsonSchema, 'boolean')
        assert.equal(typeof caps.jsonObject, 'boolean')
      }
    )
  })
}
