/**
 * `flavor: 'anthropic'` implementation of `ProviderAdapter` — native
 * Anthropic Messages API client (FR-27, PRD §11.2), covering the first-party
 * `api.anthropic.com` endpoint. Unlike `openai-compatible.ts`, this adapter
 * does not go through `structured-output.ts`'s degradation ladder: Anthropic
 * has one native structured-output mechanism (`output_config`, T9.6), no
 * fallback rungs to climb, so `complete()` is a single `withRetry`-wrapped
 * attempt.
 *
 * Deliberately NOT sent, per PRD §11.2 ("Особенности, которые учитывает
 * адаптер anthropic.ts"):
 *   - `temperature`/`top_p`/`top_k` — rejected with 400 on the Opus 5 /
 *     Sonnet 5 / Opus 4.8/4.7 line (T9.9);
 *   - `thinking`/`budget_tokens` in any shape — no FR exposes a thinking-
 *     budget config surface, and Opus 5 already thinks by default
 *     server-side, so there is nothing for the adapter to request (T9.8);
 *   - an assistant-prefill trick (seeding the last assistant message with
 *     `"{"` to coax JSON) — `output_config.format` is the one and only
 *     structured-output path here (T9.7).
 */

import { ProviderError } from '../util/errors.ts'
import { redact } from '../util/secrets.ts'
import { registerSecret } from '../util/secrets.ts'
import { joinUrl, parseRetryAfterMs, truncate } from './http.ts'
import { withRetry, HttpStatusError, type RetryOptions } from './retry.ts'
import { sanitizeJsonSchema } from './structured-output.ts'
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderCapabilities,
  ToolCall,
  ToolSpec,
  TokenUsage
} from './types.ts'

export interface AnthropicAdapterConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Custom headers (`api.headers` in config) — merged in last, so a custom
   * `x-api-key`/`anthropic-version` override wins, mirroring
   * `openai-compatible.ts`'s `Authorization` override behavior (T3.5). */
  headers: Record<string, string>
  requestTimeoutMs: number
  retry?: RetryOptions
}

const MESSAGES_PATH = '/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const BODY_SNIPPET_MAX_LENGTH = 500

/** Anthropic's sole cache TTL shape today — 5-minute ephemeral breakpoints. */
type CacheControl = { type: 'ephemeral' }

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: CacheControl }

interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control: CacheControl
}

interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

function buildHeaders (apiKey: string, customHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  }
  // An empty apiKey means auth is delegated to a custom header (e.g. a
  // gateway that wants Authorization instead of x-api-key, T26) — sending an
  // empty x-api-key is worse than omitting it, some gateways reject it outright.
  if (apiKey !== '') {
    headers['x-api-key'] = apiKey
  }
  for (const [key, value] of Object.entries(customHeaders)) {
    for (const existingKey of Object.keys(headers)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) delete headers[existingKey]
    }
    headers[key] = value
  }
  return headers
}

/**
 * Anthropic has no `role: 'tool'` message type — a tool result is a
 * `role: 'user'` message with `tool_result` content block(s). When
 * `AgentEngine`'s loop makes several tool calls in one turn, it pushes one
 * `ChatMessage` per result (T7.x convention) — these are merged back into a
 * single `user` turn here (T9.5b) rather than sent as several consecutive
 * `user` messages, matching Anthropic's documented multi-tool-result shape.
 */
function toWireMessages (messages: readonly ChatMessage[]): AnthropicWireMessage[] {
  const result: AnthropicWireMessage[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (!message) break

    if (message.role === 'tool') {
      const blocks: AnthropicContentBlock[] = []
      while (i < messages.length) {
        const toolMessage = messages[i]
        if (!toolMessage || toolMessage.role !== 'tool') break
        blocks.push({
          type: 'tool_result',
          tool_use_id: toolMessage.toolCallId ?? '',
          content: toolMessage.content
        })
        i++
      }
      result.push({ role: 'user', content: blocks })
      continue
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })
      }
      result.push({ role: 'assistant', content: blocks })
      i++
      continue
    }

    result.push({ role: 'user', content: [{ type: 'text', text: message.content }] })
    i++
  }
  return result
}

function toWireTool (tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: sanitizeJsonSchema(tool.parameters)
  }
}

/**
 * Prompt caching (#11, PRD §11.2): three fixed breakpoints keep the frozen
 * prefix (system + tool definitions) and, from the second turn on, the
 * growing tool-result history off the metered-price path on every repeat
 * request within an `AgentEngine` loop:
 *   - the system block (always — it's static per review run);
 *   - the last `tools[]` entry (Anthropic caches everything up to and
 *     including a breakpoint, so one at the end covers the whole list);
 *   - the last `tool_result` block of the last message, but only once
 *     `req.messages.length > 2` — a fresh single-turn request has no tool
 *     history yet, so caching it there would just pay the cache-write
 *     premium for content that's never read back.
 */
function applyCacheControl (wireMessages: AnthropicWireMessage[], messages: readonly ChatMessage[]): void {
  if (messages.length <= 2) return
  const lastMessage = wireMessages[wireMessages.length - 1]
  if (!lastMessage || lastMessage.role !== 'user') return
  const lastBlock = lastMessage.content[lastMessage.content.length - 1]
  if (lastBlock?.type === 'tool_result') {
    lastBlock.cache_control = { type: 'ephemeral' }
  }
}

function buildRequestBody (req: CompletionRequest, model: string): Record<string, unknown> {
  const wireMessages = toWireMessages(req.messages)
  applyCacheControl(wireMessages, req.messages)

  const system: AnthropicSystemBlock[] = [
    { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }
  ]

  const body: Record<string, unknown> = {
    model,
    system,
    messages: wireMessages,
    max_tokens: req.maxOutputTokens
  }
  if (req.tools && req.tools.length > 0) {
    const wireTools = req.tools.map(toWireTool)
    const lastTool = wireTools[wireTools.length - 1]
    if (lastTool) lastTool.cache_control = { type: 'ephemeral' }
    body.tools = wireTools
  }
  if (req.responseSchema) {
    body.output_config = {
      format: { type: 'json_schema', schema: sanitizeJsonSchema(req.responseSchema) }
    }
  }
  return body
}

function parseToolUseBlock (block: Record<string, unknown>): ToolCall {
  return {
    id: typeof block.id === 'string' ? block.id : '',
    name: typeof block.name === 'string' ? block.name : '',
    arguments: block.input
  }
}

function translateResponse (data: unknown): CompletionResponse {
  const obj = (data ?? {}) as Record<string, unknown>
  const blocks = Array.isArray(obj.content) ? (obj.content as Array<Record<string, unknown>>) : []

  const textParts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? ''))
  const text = textParts.length > 0 ? textParts.join('\n') : null
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map(parseToolUseBlock)

  const finishReason = typeof obj.stop_reason === 'string' ? obj.stop_reason : 'unknown'

  const rawUsage = obj.usage as Record<string, unknown> | undefined
  const inputTokens = typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : 0
  const cacheCreation =
    typeof rawUsage?.cache_creation_input_tokens === 'number' ? rawUsage.cache_creation_input_tokens : 0
  const cacheRead =
    typeof rawUsage?.cache_read_input_tokens === 'number' ? rawUsage.cache_read_input_tokens : 0
  const outputTokens = typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : 0

  const usage: TokenUsage = {
    promptTokens: inputTokens + cacheCreation + cacheRead,
    completionTokens: outputTokens,
    estimated: false
  }

  return { text, toolCalls, usage, finishReason, raw: data }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly flavor = 'anthropic' as const
  private readonly config: AnthropicAdapterConfig

  constructor (config: AnthropicAdapterConfig) {
    this.config = config
    registerSecret(config.apiKey)
  }

  async complete (req: CompletionRequest): Promise<CompletionResponse> {
    return withRetry(() => this.performRequest(req), { signal: req.signal, ...this.config.retry })
  }

  /**
   * No live probe (unlike `openai-compatible.ts`'s `capabilities()`) — the
   * first-party Anthropic Messages API always supports tool calling and
   * `output_config` structured output, so there is nothing uncertain to
   * probe for. This method is also unused by any caller today
   * (`capability-probe.ts`'s header comment) — a static shape is enough.
   */
  async capabilities (): Promise<ProviderCapabilities> {
    return { toolCalling: true, jsonSchema: true, jsonObject: true }
  }

  private async performRequest (req: CompletionRequest): Promise<CompletionResponse> {
    const url = joinUrl(this.config.baseUrl, MESSAGES_PATH)
    const headers = buildHeaders(this.config.apiKey, this.config.headers)
    const body = buildRequestBody(req, this.config.model)
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal = AbortSignal.any([req.signal, timeoutSignal])

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    const bodyText = await res.text()

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      const snippet = redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))
      const retryAfterOpt = retryAfterMs !== undefined ? { retryAfterMs } : {}
      if (res.status === 401) {
        throw new HttpStatusError(401, 'Provider rejected the request: invalid api_key (HTTP 401).', {
          bodyText: snippet,
          hint: 'Check the `api_key` input for this provider.',
          ...retryAfterOpt
        })
      }
      throw new HttpStatusError(res.status, `Provider returned HTTP ${res.status}: ${snippet}`, {
        bodyText: snippet,
        ...retryAfterOpt
      })
    }

    let data: unknown
    try {
      data = JSON.parse(bodyText)
    } catch {
      throw new ProviderError(
        `Provider response was not valid JSON (HTTP ${res.status}): ${redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))}`
      )
    }

    return translateResponse(data)
  }
}
