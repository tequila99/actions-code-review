import { ProviderError } from '../util/errors.ts'
import { redact } from '../util/secrets.ts'
import { registerSecret } from '../util/secrets.ts'
import { joinUrl, parseRetryAfterMs, truncate } from './http.ts'
import { withRetry, HttpStatusError, type RetryOptions } from './retry.ts'
import {
  completeStructured,
  sanitizeJsonSchema,
  type StructuredAttemptParams
} from './structured-output.ts'
import { estimateTokens } from './token-estimate.ts'
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

export interface OpenAICompatibleAdapterConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Custom headers (`api.headers` in config) — merged in last, so a
   * custom `Authorization` header overrides the default Bearer one (T3.5). */
  headers: Record<string, string>
  requestTimeoutMs: number
  retry?: RetryOptions
}

const CHAT_COMPLETIONS_PATH = '/chat/completions'
const BODY_SNIPPET_MAX_LENGTH = 500
const TOOL_CALL_ARGS_SNIPPET_MAX_LENGTH = 200

function buildHeaders (
  apiKey: string,
  customHeaders: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  for (const [key, value] of Object.entries(customHeaders)) {
    for (const existingKey of Object.keys(headers)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) delete headers[existingKey]
    }
    headers[key] = value
  }
  return headers
}

function toRawMessage (message: ChatMessage): Record<string, unknown> {
  const raw: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.toolCallId !== undefined) raw.tool_call_id = message.toolCallId
  if (message.name !== undefined) raw.name = message.name
  if (message.toolCalls && message.toolCalls.length > 0) {
    raw.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
    }))
  }
  return raw
}

function toRawTool (tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeJsonSchema(tool.parameters)
    }
  }
}

function buildSystemContent (req: CompletionRequest, params: StructuredAttemptParams): string {
  let system = req.system
  if (req.responseSchema) {
    if (params.responseFormatStage === 'json_schema') {
      // The schema itself is passed structurally via
      // `response_format.json_schema.schema` — the model sees the real field
      // names/types there. Still add a short reminder: some backends
      // (observed: an Azure-routed OpenAI model via OpenRouter) reject the
      // request with HTTP 400 unless the messages array literally mentions
      // "json" somewhere, per OpenAI's own documented `json_object`
      // constraint. Harmless for providers that don't enforce it.
      system += '\n\nRespond in JSON, matching the provided schema.'
    } else {
      // 'json_object' mode (and 'none') carry NO schema over the wire at
      // all — `response_format: {type: 'json_object'}` only enforces
      // "valid JSON", nothing about shape. Without the schema spelled out in
      // text here, a model at this stage has no way to know the expected
      // field names and will invent plausible-looking ones instead (observed
      // in production: "file"/"summary" instead of "path"/"message").
      system += `\n\nRespond with a single JSON object matching this schema, and nothing else (no markdown, no prose):\n${JSON.stringify(sanitizeJsonSchema(req.responseSchema))}`
    }
  }
  if (params.strictJsonInstruction) {
    system +=
      '\n\nIMPORTANT: your entire response must be exactly one valid JSON value and nothing else.'
  }
  return system
}

function buildRequestBody (
  req: CompletionRequest,
  model: string,
  params: StructuredAttemptParams
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: buildSystemContent(req, params) },
      ...req.messages.map(toRawMessage)
    ]
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(toRawTool)
  }
  if (req.responseSchema) {
    if (params.responseFormatStage === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: sanitizeJsonSchema(req.responseSchema),
          strict: true
        }
      }
    } else if (params.responseFormatStage === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
  }
  body[params.maxOutputTokensParam] = req.maxOutputTokens
  if (req.temperature !== undefined) {
    body.temperature = req.temperature
  }
  return body
}

function parseToolCall (raw: unknown): ToolCall {
  const record = (raw ?? {}) as Record<string, unknown>
  const fn = (record.function ?? {}) as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof fn.name === 'string' ? fn.name : ''
  const argsText = typeof fn.arguments === 'string' ? fn.arguments : '{}'
  try {
    return { id, name, arguments: JSON.parse(argsText) }
  } catch {
    return {
      id,
      name,
      arguments: undefined,
      argumentsError: `Provider returned invalid JSON in tool call arguments: ${truncate(argsText, TOOL_CALL_ARGS_SNIPPET_MAX_LENGTH)}`
    }
  }
}

/**
 * Detects the vLLM-without-`--enable-auto-tool-choice` failure mode (§11.4):
 * tools were requested, `tool_calls` came back empty, but `content` itself
 * looks like a serialized tool call (`{"name": ..., "arguments": ...}`).
 */
function looksLikeToolCallJson (content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).name === 'string' &&
      'arguments' in (parsed as Record<string, unknown>)
    )
  } catch {
    return false
  }
}

function translateResponse (data: unknown, req: CompletionRequest): CompletionResponse {
  const obj = (data ?? {}) as Record<string, unknown>
  const choices = Array.isArray(obj.choices) ? obj.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first || typeof first !== 'object') {
    // A well-formed-but-empty `choices[]` (HTTP 200) is opaque without the rest of the body —
    // some backends put the actual reason (safety block, quota, malformed upstream request) in a
    // sibling field like `promptFeedback`/`error` instead of an HTTP error status (confirmed
    // against a real MWS-proxied gemini-2.5-pro run that returned exactly this shape). Same
    // truncate+redact treatment as the non-JSON-body case above (T3.13) — this ends up in the
    // sticky-comment Notes, so it must stay bounded and secret-free.
    const snippet = redact(truncate(JSON.stringify(data), BODY_SNIPPET_MAX_LENGTH))
    throw new ProviderError(`Provider response contained no choices. Raw response: ${snippet}`)
  }
  const message = (first.message ?? {}) as Record<string, unknown>
  const content = typeof message.content === 'string' ? message.content : null
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls = rawToolCalls.map(parseToolCall)

  if (
    req.tools &&
    req.tools.length > 0 &&
    toolCalls.length === 0 &&
    content &&
    looksLikeToolCallJson(content)
  ) {
    throw new ProviderError(
      'The model returned what looks like a tool call as plain text in `content` instead of using `tool_calls`.',
      'If this is vLLM, restart the server with `--enable-auto-tool-choice --tool-call-parser <parser>` matching the model (see PRD §11.4).'
    )
  }

  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : 'unknown'

  const rawUsage = obj.usage as Record<string, unknown> | undefined
  let usage: TokenUsage
  if (
    rawUsage &&
    typeof rawUsage.prompt_tokens === 'number' &&
    typeof rawUsage.completion_tokens === 'number'
  ) {
    usage = {
      promptTokens: rawUsage.prompt_tokens,
      completionTokens: rawUsage.completion_tokens,
      estimated: false,
      // Non-standard OpenRouter extension (`usage.cost`, real USD spent on
      // this call) — read opportunistically, never fabricated. Absent or
      // non-numeric -> `costUsd` stays unset rather than becoming `0`.
      ...(typeof rawUsage.cost === 'number' ? { costUsd: rawUsage.cost } : {})
    }
  } else {
    const promptText = [req.system, ...req.messages.map((m) => m.content)].join('\n')
    usage = {
      promptTokens: estimateTokens(promptText),
      completionTokens: estimateTokens(content ?? ''),
      estimated: true
    }
  }

  return { text: content, toolCalls, usage, finishReason, raw: data }
}

/**
 * `flavor: 'openai'` implementation of `ProviderAdapter` — an
 * OpenAI-compatible `POST {base_url}/chat/completions` client (FR-20),
 * covering vLLM/Ollama/OpenRouter/any gateway speaking the same wire
 * format. `complete()` composes `structured-output.ts` (degradation ladder,
 * owns 400 handling) over `retry.ts` (408/429/5xx/network retries) over a
 * single `fetch` call per attempt — see CHANGELOG.md "Этап 3" for why this
 * nesting lives inside the adapter rather than in `factory.ts`.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly flavor = 'openai' as const
  private readonly config: OpenAICompatibleAdapterConfig

  constructor (config: OpenAICompatibleAdapterConfig) {
    this.config = config
    registerSecret(config.apiKey)
  }

  async complete (req: CompletionRequest): Promise<CompletionResponse> {
    const { response, stage } = await completeStructured(req, (params) =>
      this.sendOnce(req, params)
    )
    const rawBase =
      response.raw !== null && typeof response.raw === 'object'
        ? (response.raw as Record<string, unknown>)
        : {}
    return { ...response, raw: { ...rawBase, degradationStage: stage } }
  }

  async capabilities (): Promise<ProviderCapabilities> {
    try {
      await this.complete({
        system:
          'You are a capability probe. Respond with a JSON object {"ok": true} and nothing else.',
        messages: [{ role: 'user', content: 'probe' }],
        responseSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok']
        },
        maxOutputTokens: 32,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      })
      return { toolCalling: true, jsonSchema: true, jsonObject: true }
    } catch {
      return { toolCalling: false, jsonSchema: false, jsonObject: false }
    }
  }

  private async sendOnce (
    req: CompletionRequest,
    params: StructuredAttemptParams
  ): Promise<CompletionResponse> {
    return withRetry(() => this.performRequest(req, params), {
      signal: req.signal,
      ...this.config.retry
    })
  }

  private async performRequest (
    req: CompletionRequest,
    params: StructuredAttemptParams
  ): Promise<CompletionResponse> {
    const url = joinUrl(this.config.baseUrl, CHAT_COMPLETIONS_PATH)
    const headers = buildHeaders(this.config.apiKey, this.config.headers)
    const body = buildRequestBody(req, this.config.model, params)
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal = AbortSignal.any([req.signal, timeoutSignal])

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    const bodyText = await res.text()

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      const snippet = redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))
      const retryAfterOpt = retryAfterMs !== undefined ? { retryAfterMs } : {}
      if (res.status === 401) {
        throw new HttpStatusError(
          401,
          'Provider rejected the request: invalid api_key (HTTP 401).',
          {
            bodyText: snippet,
            hint: 'Check the `api_key` input for this provider.',
            ...retryAfterOpt
          }
        )
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

    return translateResponse(data, req)
  }
}
