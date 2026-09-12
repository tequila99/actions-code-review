/**
 * `AgentEngine` tool registry (FR-40..FR-50). Shared tool-facing types live
 * here (rather than in each tool module) so every tool file and
 * `agent-engine.ts` import one definition instead of six near-identical
 * ones; `buildToolRegistry` itself is filled in once every individual tool
 * module exists (see the tool imports below).
 */

import type { ToolSpec } from '../../provider/types.ts'
import type { ReviewTarget } from '../types.ts'
import type { CommentAccumulator } from './post-comment.ts'
import type { WebSearchCallBudget } from './web-search.ts'
import { READ_FILE_SPEC, readFile } from './read-file.ts'
import { LIST_FILES_SPEC, listFiles } from './list-files.ts'
import { GREP_SPEC, grep } from './grep.ts'
import { GET_DIFF_SPEC, getDiff } from './get-diff.ts'
import { buildPostCommentSpec, postComment } from './post-comment.ts'
import { WEB_SEARCH_SPEC, webSearch } from './web-search.ts'

/** Every tool result is a single text blob plus an error flag — this is
 * exactly the OpenAI `role: 'tool'` message shape once wrapped with a
 * `tool_call_id` (`agent-engine.ts` does that wrapping). `isError: true`
 * still returns as a normal tool result (never a thrown exception) so the
 * model sees it and can retry/adjust, per FR-49/T7.16 ("result-error, not
 * exception"). */
export interface ToolResult {
  content: string
  isError: boolean
}

/** Everything `web_search`'s handler needs to reach OpenRouter's
 * `openrouter:web_search` server tool on its own, separate sub-request
 * (THR-11) — `budget` is a fresh `WebSearchCallBudget` per run, shared
 * across every `web_search` call in that run so the cap is enforced across
 * calls, not per call. Always built by `agent-engine.ts`, even when the
 * tool isn't registered (mirrors `allowSuggestions` always being set
 * regardless of whether `post_comment`'s spec exposes those fields). */
export interface WebSearchRunContext {
  apiKey: string
  baseUrl: string
  model: string
  maxCalls: number
  extraHeaders: Record<string, string>
  budget: WebSearchCallBudget
}

/** Per-run state every tool handler needs. Built once by `agent-engine.ts`
 * at the start of `review()` and threaded through every tool call. */
export interface ToolExecutionContext {
  workspaceRoot: string
  toolOutputMaxBytes: number
  contextLines: number
  target: ReviewTarget
  comments: CommentAccumulator
  /** Дополнение D (FR-51): gates whether `post_comment` accepts a verified
   * literal code-suggestion pair. Threaded from `config.agent.allow_suggestions`
   * — see `buildToolRegistry` below, which uses the same flag to decide
   * whether the model is even offered the fields. */
  allowSuggestions: boolean
  webSearch: WebSearchRunContext
  /** The run's overall `AbortSignal` (`total_timeout_ms`, THR-8) — `web_search`
   * combines this with its own shorter per-call timeout via `AbortSignal.any`
   * (same combinator `provider/openai-compatible.ts` already uses for the
   * main request) so an in-flight sub-fetch is cut short the instant the
   * overall run timeout fires, not just at its own 45s ceiling. */
  runSignal: AbortSignal
}

export type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>

export interface ToolRegistry {
  specs: ToolSpec[]
  handlers: Map<string, ToolHandler>
}

interface RegisteredTool {
  spec: ToolSpec
  handler: ToolHandler
}

/**
 * Builds the tool set the model is offered this run. `enabledTools` is
 * `config.agent.tools` (FR-45/T7.45) — an empty array means "every tool
 * below", a non-empty array narrows to exactly those names (unknown names
 * are ignored, not an error: the config schema doesn't validate tool names
 * against this list to avoid a config-schema <-> tool-registry coupling).
 * `allowSuggestions` (`config.agent.allow_suggestions`, Дополнение D) gates
 * `post_comment`'s spec itself — when `false` the model never even sees
 * `original_snippet`/`suggestion` as callable parameters, not just a
 * rejection at the handler layer.
 *
 * THR-9/SEC-4: except for `web_search` (THR-11, Дополнение F), this list is
 * the entire tool surface `AgentEngine` can ever expose — there is no
 * `write_file`, `bash`/`run`, or other network tool, and none can be added
 * through configuration. `web_search` itself is opt-in and off by default
 * (`webSearchEnabled` below, `config.agent.web_search.enabled`) — omitted
 * from `allTools` entirely unless explicitly turned on, so an empty
 * `enabledTools` allowlist ("every tool") can never silently include it.
 */
export function buildToolRegistry (
  enabledTools: readonly string[],
  allowSuggestions: boolean = true,
  webSearchEnabled: boolean = false
): ToolRegistry {
  const allTools: RegisteredTool[] = [
    { spec: READ_FILE_SPEC, handler: readFile },
    { spec: LIST_FILES_SPEC, handler: listFiles },
    { spec: GREP_SPEC, handler: grep },
    { spec: GET_DIFF_SPEC, handler: getDiff },
    { spec: buildPostCommentSpec(allowSuggestions), handler: postComment }
  ]
  if (webSearchEnabled) allTools.push({ spec: WEB_SEARCH_SPEC, handler: webSearch })
  const allowAll = enabledTools.length === 0
  const allowed = new Set(enabledTools)
  const selected = allowAll ? allTools : allTools.filter((t) => allowed.has(t.spec.name))

  const specs = selected.map((t) => t.spec)
  const handlers = new Map(selected.map((t) => [t.spec.name, t.handler] as const))
  return { specs, handlers }
}
