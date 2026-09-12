/**
 * `web_search` tool (Дополнение F, THR-11) — opt-in, off by default
 * (`config.agent.web_search.enabled`). Unlike every other tool in this
 * registry, this one makes an outbound network call: it does NOT go through
 * `ProviderAdapter`/`CompletionRequest` (that contract stays
 * provider-agnostic, see `provider/types.ts`) — the handler makes its own
 * separate `fetch` call straight to OpenRouter's `openrouter:web_search`
 * server tool, on a sub-request independent of the model's own turn. This is
 * OpenRouter-only for now (`isOpenRouterHost` below is the single extension
 * point a future non-OpenRouter backend would branch on — deliberately a
 * concrete function, not an interface, until a second backend is actually
 * needed).
 *
 * Security posture (THR-11, PRD.md §10.1): the query text is model-composed
 * and can be influenced by a malicious PR (THR-3), so it's the one place in
 * this codebase where untrusted content leaves the process. Mitigated by:
 * being opt-in/off-by-default, a per-run call cap independent of
 * `agent_max_tool_calls` (`WebSearchCallBudget`), `redact()` on the outgoing
 * query (strips only the two known credential strings verbatim — NOT a
 * general secrets/exfiltration scrubber), and wrapping the result in
 * `<untrusted_content>` (a deliberate deviation from every other tool here,
 * none of which literally wrap their own output today — this is the first
 * tool whose output is third-party content).
 */

import { redact } from '../../util/secrets.ts'
import type { ToolExecutionContext, ToolResult, WebSearchRunContext } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'

export const WEB_SEARCH_SPEC: ToolSpec = {
  name: 'web_search',
  description:
    'Search the web for information not available in this repository checkout — library/API ' +
    'behavior, current documentation, CVE details. Do NOT use this to look for files inside this ' +
    'repository or its dependencies (e.g. node_modules) — grep/read_file/list_files cover that, ' +
    'and dependency source is not present in this checkout. Do NOT use this to search for ' +
    'yourself, this tool, or the model/provider running this review — that is never relevant to ' +
    'the pull request. This is an opt-in tool with a small per-run call limit — use it sparingly, ' +
    'only when it would materially change your review of the pull request.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' }
    },
    required: ['query']
  }
}

/** Independent of `request_timeout_ms`/`total_timeout_ms` — this is a
 * separate sub-request the tool loop is not otherwise waiting on. */
const WEB_SEARCH_REQUEST_TIMEOUT_MS = 45_000

/** Independent of `review.max_output_tokens` — keeps a slow/reasoning-heavy
 * model's search sub-call bounded (the same failure mode the wall-clock
 * wrap-up nudge in `agent-engine.ts` addresses for the main loop: a model
 * that spends most of its output budget on hidden reasoning with little
 * left for an actual answer). */
const WEB_SEARCH_MAX_OUTPUT_TOKENS = 2_000

const BODY_SNIPPET_MAX_LENGTH = 500

export interface WebSearchCallBudget {
  tryConsume (): boolean
  readonly used: number
}

class Budget implements WebSearchCallBudget {
  private readonly cap: number
  private count = 0

  constructor (cap: number) {
    this.cap = cap
  }

  get used (): number {
    return this.count
  }

  tryConsume (): boolean {
    if (this.count >= this.cap) return false
    this.count++
    return true
  }
}

/** `cap` is `config.agent.web_search.max_calls` — independent of
 * `agent_max_tool_calls` (THR-11/THR-8). */
export function createWebSearchCallBudget (cap: number): WebSearchCallBudget {
  return new Budget(cap)
}

function isOpenRouterHost (baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai'
  } catch {
    return false
  }
}

function truncate (content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8')
  if (buf.byteLength <= maxBytes) return content
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n… (truncated, output exceeded ${maxBytes} bytes)`
}

interface UrlCitation {
  url: string
  title?: string
}

/** Best-effort: OpenRouter's older, now-deprecated `:online`/`plugins`
 * web-search shorthand documents `message.annotations[].url_citation`
 * (`{type:'url_citation', url_citation:{url, title}}`) — this server tool's
 * response shape isn't fully confirmed from documentation alone (see
 * PLAN.md's "Open risk" note). Absent/malformed annotations are silently
 * ignored, never an error — citations are a nice-to-have on top of the
 * answer text, not something the tool depends on. */
function extractCitations (message: Record<string, unknown>): UrlCitation[] {
  const annotations = message.annotations
  if (!Array.isArray(annotations)) return []
  const citations: UrlCitation[] = []
  for (const entry of annotations) {
    const record = entry as Record<string, unknown>
    const citation = record.url_citation as Record<string, unknown> | undefined
    if (citation && typeof citation.url === 'string') {
      citations.push({
        url: citation.url,
        ...(typeof citation.title === 'string' ? { title: citation.title } : {})
      })
    }
  }
  return citations
}

function formatResult (text: string, citations: UrlCitation[]): string {
  const parts = [text]
  if (citations.length > 0) {
    parts.push('Sources:')
    parts.push(...citations.map((c) => (c.title ? `- ${c.title}: ${c.url}` : `- ${c.url}`)))
  }
  return `<untrusted_content>\n${parts.join('\n')}\n</untrusted_content>`
}

function buildHeaders (apiKey: string, extraHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    for (const existingKey of Object.keys(headers)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) delete headers[existingKey]
    }
    headers[key] = value
  }
  return headers
}

/** The one extension point for a future second (non-OpenRouter) backend —
 * a single concrete function today, not an interface, per "no speculative
 * abstraction" (CLAUDE.md): there's exactly one backend to support right
 * now, and this is where a second branch would go if/when one is added. */
async function search (
  query: string,
  ctx: WebSearchRunContext,
  runSignal: AbortSignal,
  toolOutputMaxBytes: number
): Promise<ToolResult> {
  if (!isOpenRouterHost(ctx.baseUrl)) {
    return {
      content:
        'web_search failed: this tool only works against OpenRouter (api_base_url must be ' +
        'https://openrouter.ai/api/v1) — the endpoint configured for this run is not OpenRouter.',
      isError: true
    }
  }
  if (!ctx.budget.tryConsume()) {
    return {
      content: `web_search failed: call limit (${ctx.maxCalls}) reached for this run`,
      isError: true
    }
  }

  const body = {
    model: ctx.model,
    messages: [{ role: 'user', content: redact(query) }],
    tools: [{ type: 'openrouter:web_search' }],
    max_tokens: WEB_SEARCH_MAX_OUTPUT_TOKENS
  }

  let res: Response
  try {
    res = await fetch(`${ctx.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(ctx.apiKey, ctx.extraHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.any([runSignal, AbortSignal.timeout(WEB_SEARCH_REQUEST_TIMEOUT_MS)])
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `web_search failed: request error: ${redact(message)}`, isError: true }
  }

  const bodyText = await res.text()
  if (!res.ok) {
    return {
      content: `web_search failed: HTTP ${res.status} from OpenRouter: ${redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))}`,
      isError: true
    }
  }

  let data: unknown
  try {
    data = JSON.parse(bodyText)
  } catch {
    return {
      content: `web_search failed: non-JSON response from OpenRouter: ${redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))}`,
      isError: true
    }
  }

  const choices = Array.isArray((data as Record<string, unknown>)?.choices)
    ? (data as Record<string, unknown>).choices as unknown[]
    : []
  const message = (choices[0] as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined
  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  if (text === '') {
    return {
      content: `web_search failed: empty response content from OpenRouter: ${redact(truncate(bodyText, BODY_SNIPPET_MAX_LENGTH))}`,
      isError: true
    }
  }

  const citations = extractCitations(message ?? {})
  return { content: truncate(formatResult(text, citations), toolOutputMaxBytes), isError: false }
}

export async function webSearch (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  const query = typeof a.query === 'string' ? a.query.trim() : ''
  if (query === '') {
    return { content: 'web_search failed: query must be a non-empty string', isError: true }
  }
  return search(query, ctx.webSearch, ctx.runSignal, ctx.toolOutputMaxBytes)
}
