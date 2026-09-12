/**
 * Provider-agnostic contract (verbatim field names). Every review engine
 * (stage 4+) talks to a `ProviderAdapter` only — it knows nothing about
 * OpenAI/Anthropic/Gemini specifics, and a `ProviderAdapter` knows nothing
 * about review/diff concerns. See `openai-compatible.ts` for the
 * call-layering rationale (structured-output.ts -> retry.ts ->
 * openai-compatible.ts).
 */

/** A conservative JSON-Schema-like object. See `structured-output.ts` for
 * the allowlist actually sent to providers (no `oneOf`/`allOf`/`$ref`/
 * `pattern`). */
export type JsonSchema = Record<string, unknown>

export type ChatRole = 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Present when `role: 'tool'` — the `tool_call_id` this message answers. */
  toolCallId?: string
  /** Present when `role: 'tool'` — the tool name (some flavors want it). */
  name?: string
  /**
   * Present when `role: 'assistant'` and the turn being replayed made tool
   * calls (`AgentEngine`'s multi-turn loop, stage 7/FR-25). OpenAI's own
   * protocol requires the assistant message that requested a tool call to
   * be present in history before the matching `role: 'tool'` result
   * messages — omitting it is rejected by real backends as a malformed
   * conversation, even though a fake-provider test can't catch that.
   */
  toolCalls?: ToolCall[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ToolCall {
  id: string
  name: string
  /** Parsed `arguments` JSON. `undefined` when parsing failed — see `argumentsError` (T3.9). */
  arguments: unknown
  /** Set instead of throwing when the provider returned invalid JSON in `arguments`. */
  argumentsError?: string
}

/**
 * `promptTokens`/`completionTokens` come straight from the provider's
 * `usage` field when present (FR-24). When the provider omits `usage`,
 * `token-estimate.ts` fills in an estimate and `estimated` is `true` — this
 * flag is what lets budget/cost code (stage 8) know the numbers are not
 * exact.
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  estimated: boolean
  /**
   * The provider's own reported cost of this single call, in USD, when it
   * chose to return one. This is NOT part of the OpenAI Chat Completions
   * contract — it is a non-standard extension some gateways add on top of
   * `usage` (example: OpenRouter's `usage.cost`). Read opportunistically:
   * `undefined` means the provider did not report it, not that the cost was
   * zero.
   */
  costUsd?: number
}

export interface CompletionRequest {
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  responseSchema?: JsonSchema
  maxOutputTokens: number
  temperature?: number
  signal: AbortSignal
}

export interface CompletionResponse {
  text: string | null
  toolCalls: ToolCall[]
  usage: TokenUsage
  finishReason: string
  /** Raw provider response body, for debug logs only. */
  raw: unknown
}

export interface ProviderAdapter {
  readonly flavor: 'openai' | 'anthropic' | 'gemini'
  complete(req: CompletionRequest): Promise<CompletionResponse>
}
