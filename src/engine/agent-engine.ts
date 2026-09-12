/**
 * `AgentEngine` (FR-40..FR-50): the agentic tool-loop. The model decides for
 * itself which tools to call (`get_diff`/`read_file`/`list_files`/`grep`)
 * and records findings via `post_comment`, ending the review by calling
 * `finish` (a control-flow primitive handled directly here, not a
 * `tools/registry.ts` entry — see that file's header) or simply answering
 * with plain text once it has nothing left to check (T7.40).
 */

import { logger, debugLog, truncateForLog } from '../util/logger.ts'
import { estimateCost, isBudgetTrackable, toPricing } from '../report/cost.ts'
import { defaultSummary } from '../report/findings.ts'
import { filterNoise } from './noise-filter.ts'
import type { ChatMessage, CompletionResponse, ToolCall, ToolSpec } from '../provider/types.ts'
import { buildToolRegistry, type ToolRegistry, type ToolExecutionContext } from './tools/registry.ts'
import { createCommentAccumulator } from './tools/post-comment.ts'
import { createWebSearchCallBudget } from './tools/web-search.ts'
import { buildAgentSystemPrompt } from './prompt/agent-system.ts'
import { sanitizeUntrustedText, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from './prompt/diff-user.ts'
import type {
  ReviewContext,
  ReviewEngine,
  ReviewResult,
  ReviewPullRequestInfo,
  ReviewTarget
} from './types.ts'
import type { DiffFile } from '../github/diff-parse.ts'

const FINISH_SPEC: ToolSpec = {
  name: 'finish',
  description: 'Call this when the review is complete, with a short overall summary.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary']
  }
}

/** Confirmed against real production traces (gpt-5 and gpt-4.1, both via MWS, on the same
 * cross-file diff): regardless of model or reasoning-heaviness, the agent can keep issuing
 * perfectly reasonable, targeted tool calls all the way to `agent_max_iterations` without ever
 * calling `post_comment` or `finish` — "cover the whole diff" is an unbounded goal on any
 * multi-file change, so nothing in the prompt alone forces a decision. This many iterations
 * before the limit, inject one explicit user-turn nudge forcing the model to wrap up now (R-3
 * style, same pattern as `REPEAT_WARNING_THRESHOLD` below) — model-agnostic, since it's a hard
 * deadline, not a request the model can keep deferring (TQ.1/TQ.2). */
const NEAR_ITERATION_LIMIT_WARNING = 3

/** Same wrap-up nudge as `NEAR_ITERATION_LIMIT_WARNING`, but keyed on wall-clock time against
 * `total_timeout_ms` instead of iteration count — confirmed on a real production trace (z-ai/
 * glm-5.2 via OpenRouter) where the model chased one correctness question about OpenTelemetry
 * instrumentation internals (repeatedly `list_files`/`grep`-ing for `node_modules` source that
 * doesn't exist in the checked-out repo) for 21 iterations and ~15 minutes, spending 1-4 minutes
 * per turn on hidden reasoning, and got cut off by `total_timeout_ms` at iteration 21 — nowhere
 * near `agent_max_iterations` (30), so the iteration-based nudge never fired, and zero
 * `post_comment` calls were ever made. A slow/verbose model can exhaust the wall-clock budget long
 * before it exhausts the iteration budget, so this needs its own independent trigger. */
const NEAR_TIME_LIMIT_REMAINING_FRACTION = 0.2

/** Same wrap-up nudge again, keyed on cumulative `promptTokens + completionTokens` against
 * `agent_token_budget` — confirmed on a real production trace (anthropic/claude-sonnet-5 via
 * OpenRouter) where the model did nothing but legitimate, non-repeating exploration (grep/
 * read_file, no loops) for 37 iterations and ~8 minutes, called `post_comment` zero times, and got
 * cut off by `token_budget` — nowhere near `agent_max_iterations` (60, only 37 used) or
 * `total_timeout_ms` (only ~43% of it elapsed), so neither of the other two nudges ever had a
 * chance to fire. A thorough/verbose model can exhaust the token budget long before it exhausts
 * either the iteration or the wall-clock budget, so this needs its own independent trigger too. */
const NEAR_TOKEN_BUDGET_REMAINING_FRACTION = 0.2

/** Same wrap-up nudge again, keyed on `toolCallsMade` against `agent_max_tool_calls` — confirmed
 * on a real production trace (x-ai/grok-4.6 via OpenRouter, an 84-file monorepo PR) where the
 * iteration (60), wall-clock (1100s) and token (2M) budgets were all set generously, leaving the
 * tool-call limit (100) as the only one that actually bound — and the only one of the five stop
 * conditions with no nudge at all. The run was cut off mid-turn at iteration 23 having called
 * `post_comment` zero times, so ~1.4M prompt tokens of real exploration were thrown away. A model
 * that batches 4-6 calls per turn burns the tool-call budget several times faster than the
 * iteration budget, so this needs its own independent trigger too. */
const NEAR_TOOL_CALL_LIMIT_REMAINING_FRACTION = 0.2

/** ...and the same again for `budget.max_cost_usd` (T8.6), the fifth stop condition, which had no
 * nudge either: a run can hit its cost ceiling with findings gathered and none posted. */
const NEAR_COST_BUDGET_REMAINING_FRACTION = 0.2

/** All five wrap-up nudges above share one instruction and differ only in why they fired, so the
 * text lives here once. Telling the model to batch every remaining finding into a single turn
 * matters more than it reads: one finding per iteration reliably runs out before `finish`. */
function wrapUpNudge (reason: string): string {
  return (
    `${reason} If you have multiple findings, call post_comment for all of them now as separate ` +
    'tool calls in the same turn — do not spread them one-per-iteration, or you may run out ' +
    'before calling finish. Then call finish immediately — even if you found nothing worth ' +
    'flagging, call finish and say so. Do not spend what is left on further exploration.'
  )
}

/** A model that issues the exact same tool call this many times over the whole run — not
 * necessarily consecutively, see `signatureCounts` below (TN.5) — gets one in-conversation warning
 * (R-3, T7.43). */
const REPEAT_WARNING_THRESHOLD = 3
/** ...and is force-stopped if it does it this many times. */
const REPEAT_ABORT_THRESHOLD = 5

/** A response with no tool calls and no visible text is ambiguous, not a deliberate "review
 * complete" signal — the model may have exhausted `maxOutputTokens` on hidden reasoning before
 * ever acting (same failure mode as `capability-probe.ts`'s retry, confirmed empirically on
 * MWS-hosted gpt-5: a full 4000-token completion budget spent with zero visible output, reported
 * as `finishReason: "length"`). Checking `finishReason === 'length'` alone isn't enough, though:
 * confirmed on a real production trace (z-ai/glm-5.2 via OpenRouter, `max_output_tokens: 10000`)
 * where the model burned its very first turn on 18 completion tokens of invisible reasoning, then
 * reported `finishReason: "stop"` with `content: null` and no `tool_calls` — nowhere near the
 * output budget, so this wasn't truncation, just a wasted turn. The system prompt requires every
 * finding and the "nothing to review" case to go through `post_comment`/`finish` (T7.40), so a
 * response with no tool calls and empty/null text is never a legitimate "I have nothing to say" —
 * unlike TM.3, where the model *did* produce visible text alongside no tool calls. One retry with
 * a larger budget resolves most of these; if the retry is *also* empty, that's reported as
 * `response_truncated` rather than silently treated as "nothing to review". */
const TRUNCATED_RESPONSE_RETRY_MULTIPLIER = 2

/** How many out-of-scope paths the opening inventory spells out before collapsing the rest into a
 * count. The in-scope list is already bounded by `filters.max_files`; the dropped list is not — a
 * PR touching a generated lockfile tree can drop thousands, which is not worth the context. */
const MAX_LISTED_SKIPPED_FILES = 40

function changeSummary (file: DiffFile): string {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++
      else if (line.type === 'del') removed++
    }
  }
  return `${file.status}, +${added} -${removed}`
}

/**
 * The opening turn. Beyond the PR title/body, this hands the model the file inventory up front:
 * confirmed on a real production trace (x-ai/grok-4.6, an 84-file monorepo PR) where the model
 * had no way to know which files existed or which had been dropped by `select-files`, and spent
 * 20 of its 100 tool calls on `get_diff`/`read_file` for paths it was guessing — re-asking for the
 * same dropped file twice, because "not one of the files in this pull request's diff" reads as
 * "this file is not in the PR" and contradicted what it had inferred from the diff.
 *
 * SEC-1: paths come from the PR just like the title/body, so they go inside `<untrusted_content>`.
 * SEC-2: title/body/path/reason all pass through `sanitizeUntrustedText` first — a title
 * containing a literal `</untrusted_content>` must not be able to forge the closing tag and
 * smuggle its own "instructions" out into trusted territory.
 */
function buildInitialUserMessage (pr: ReviewPullRequestInfo, target: ReviewTarget): string {
  const title = sanitizeUntrustedText(pr.title)
  const body = sanitizeUntrustedText(pr.body ?? '(no description provided)')
  const parts = [
    'Pull request under review:',
    '<untrusted_content>',
    `Title: ${title}`,
    `Description: ${body}`,
    '</untrusted_content>'
  ]

  if (target.files.length > 0) {
    parts.push(
      `Files in the review scope (${target.files.length}) — get_diff accepts exactly these paths:`,
      '<untrusted_content>',
      ...target.files.map((file) => `${sanitizeUntrustedText(file.path)} (${changeSummary(file)})`),
      '</untrusted_content>'
    )
  }

  if (target.skipped.length > 0) {
    const listed = target.skipped.slice(0, MAX_LISTED_SKIPPED_FILES)
    const remaining = target.skipped.length - listed.length
    parts.push(
      `These ${target.skipped.length} file(s) are part of the pull request but fell outside the ` +
        'review scope. get_diff will refuse them — read_file still works, since they are present ' +
        'in the checkout. Do not spend tool calls rediscovering this:',
      '<untrusted_content>',
      ...listed.map((file) => `${sanitizeUntrustedText(file.path)} — ${sanitizeUntrustedText(file.reason)}`),
      ...(remaining > 0 ? [`… and ${remaining} more file(s), same reason(s)`] : []),
      '</untrusted_content>'
    )
  }

  parts.push(
    'Start by calling get_diff to see the changes, then use the other tools as needed to gather ' +
      'enough context. Call post_comment for every finding, then call finish when the review is complete.'
  )
  return parts.join('\n')
}

/**
 * SEC-2: every tool result reaches the model as a `role: 'tool'` message, and any of them can
 * carry attacker-influenced content (a file's own text via read_file/grep, a repo path via
 * list_files/get_diff, a third-party page via web_search) — the same threat `buildInitialUserMessage`
 * addresses for the PR title/body/paths. Wrapping happens once, here, for every tool regardless of
 * `isError` (an error message can quote back attacker-controlled input just as easily as a
 * success), rather than in each tool module — `web_search` used to wrap its own output and nothing
 * else did, which stopped being an option once every tool needed the same treatment (a second
 * wrap would be visible to the model as a nested, and therefore trivially confusing, boundary).
 */
function wrapToolResult (content: string): string {
  return `${UNTRUSTED_OPEN}\n${sanitizeUntrustedText(content)}\n${UNTRUSTED_CLOSE}`
}

function callSignature (toolCalls: readonly ToolCall[]): string {
  return JSON.stringify(toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })))
}

type StopReason =
  | 'finished'
  | 'no_tool_calls'
  | 'iteration_limit'
  | 'tool_call_limit'
  | 'token_budget'
  | 'budget_exceeded'
  | 'aborted'
  | 'repeat_loop'
  | 'response_truncated'
  | 'provider_error'

function isInconclusiveTruncation (response: CompletionResponse): boolean {
  return response.toolCalls.length === 0 && (response.text ?? '').trim() === ''
}

/** Which stops are worth one last-chance turn (TW.4). Every limit here cuts the model off
 * mid-thought, and on a large PR that routinely happens before it has called `post_comment` even
 * once — the entire run's spend then buys nothing. Deliberately excludes `budget_exceeded` (the
 * user set a hard cost ceiling and it is already spent; one more call would breach it further) and
 * `aborted`/`provider_error`/`response_truncated`, where the provider is in no state to answer. */
const SALVAGEABLE_STOP_REASONS: ReadonlySet<StopReason> = new Set([
  'iteration_limit',
  'tool_call_limit',
  'token_budget',
  'repeat_loop'
])

/** The `tool_call_limit` stop breaks out of the middle of a turn's tool calls, leaving the trailing
 * ones with no matching `role: 'tool'` reply — a message shape every OpenAI-compatible API rejects
 * outright, so the last-chance turn below would 400 before it ever reached the model. Fills the
 * gaps in first. Collects before pushing rather than appending while iterating. */
function answerDanglingToolCalls (messages: ChatMessage[]): void {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
  const missing: ChatMessage[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (answered.has(call.id)) continue
      answered.add(call.id)
      missing.push({
        role: 'tool',
        content: 'Not executed: this review ran out of budget before the call was made.',
        toolCallId: call.id,
        name: call.name
      })
    }
  }
  messages.push(...missing)
}

export class AgentEngine implements ReviewEngine {
  readonly name = 'agent' as const

  /** Test-only seam: a real run always builds its registry from
   * `config.agent.tools` (`review()` below); tests that need a handler to
   * misbehave in ways none of the real tools do (T7.35: a tool throwing)
   * inject a substitute registry here instead of monkey-patching a real
   * tool module. */
  private readonly registryOverride: ToolRegistry | undefined

  constructor (registryOverride?: ToolRegistry) {
    this.registryOverride = registryOverride
  }

  async review (ctx: ReviewContext): Promise<ReviewResult> {
    const { config } = ctx
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()
    const deadlineAt = Date.now() + config.api.total_timeout_ms

    const registry =
      this.registryOverride ??
      buildToolRegistry(config.agent.tools, config.agent.allow_suggestions, config.agent.web_search.enabled)
    const toolsForModel: ToolSpec[] = [...registry.specs, FINISH_SPEC]
    const systemPrompt = buildAgentSystemPrompt(config, toolsForModel)

    const comments = createCommentAccumulator(3 * config.review.max_comments)
    const toolCtx: ToolExecutionContext = {
      workspaceRoot,
      toolOutputMaxBytes: config.agent.tool_output_max_bytes,
      contextLines: config.filters.context_lines,
      target: ctx.target,
      comments,
      allowSuggestions: config.agent.allow_suggestions,
      webSearch: {
        apiKey: config.api.api_key,
        baseUrl: config.api.base_url,
        model: config.model,
        maxCalls: config.agent.web_search.max_calls,
        extraHeaders: config.api.headers,
        budget: createWebSearchCallBudget(config.agent.web_search.max_calls)
      },
      runSignal: ctx.signal
    }

    const messages: ChatMessage[] = [{ role: 'user', content: buildInitialUserMessage(ctx.pr, ctx.target) }]

    // T8.6 (THR-8/R-13): a hard mid-run cost cutoff, independent of `agent_token_budget`
    // (a token count the user configures for context-window reasons, not cost). Estimate-based
    // only (`budget.pricing`), same rationale as the T8.5 pre-flight check — see `cost.ts`.
    const budgetPricing = toPricing(config.budget.pricing)
    const budgetTrackable = isBudgetTrackable(config.budget.max_cost_usd, budgetPricing, (m) =>
      logger.warning(m)
    )

    const notes: string[] = []
    if (ctx.target.skipped.length > 0) {
      notes.push(
        `${ctx.target.skipped.length} file(s) were not included in the review scope (select-files limits): ` +
          ctx.target.skipped.map((s) => s.path).join(', ')
      )
    }

    let iterations = 0
    let toolCallsMade = 0
    let promptTokens = 0
    let completionTokens = 0
    let anyEstimated = false
    let costUsd = 0
    let everyCallHadCost = true
    let summary = ''
    // Counts every call-signature occurrence across the *whole run*, not just consecutive repeats
    // (R-3, TN.5) — a model that oscillates between 2-3 stale queries (A, B, A, B, A, ...) makes no
    // progress either, but never repeats the *same* signature twice in a row, so a purely
    // consecutive check never catches it. Confirmed against a real production trace (gpt-5 via MWS)
    // re-issuing an identical grep 2 iterations apart, interleaved with a different one.
    const signatureCounts = new Map<string, number>()
    // `toolCallLimitHit` (not just `stopReason`) is what the post-loop `for`
    // breaks on — the tool-call limit is discovered *inside* the inner `for`
    // over one turn's calls, one level below the outer `while`, so a plain
    // `break` there only exits the `for`; this flag is what tells the
    // `while` to stop too (see the `if (toolCallLimitHit) break` below).
    let stopReason: StopReason = 'no_tool_calls'
    let toolCallLimitHit = false
    let nearLimitWarned = false
    let nearTimeLimitWarned = false
    let nearTokenBudgetWarned = false
    let nearToolCallLimitWarned = false
    let nearCostBudgetWarned = false

    function accumulateUsage (response: CompletionResponse): void {
      promptTokens += response.usage.promptTokens
      completionTokens += response.usage.completionTokens
      anyEstimated = anyEstimated || response.usage.estimated
      if (response.usage.costUsd !== undefined) {
        costUsd += response.usage.costUsd
      } else {
        everyCallHadCost = false
      }
    }

    function logResponseDebug (label: string, response: CompletionResponse): void {
      debugLog(
        config.debug,
        `agent-engine: ${label} — finishReason=${response.finishReason}, ` +
          `tool_calls=${response.toolCalls.map((c) => c.name).join(', ') || '(none)'}, ` +
          `usage={prompt:${response.usage.promptTokens},completion:${response.usage.completionTokens}}` +
          (response.text !== null ? `, text=${truncateForLog(response.text)}` : '')
      )
    }

    /** `DiffEngine` already survives a single batch's `provider.complete()` throwing (try/catch per
     * batch, T4.30) — this loop had no equivalent, so ANY provider failure (a mid-flight
     * `total_timeout_ms` abort, a network blip, retries exhausted) crashed the whole run via
     * `main.ts`'s generic catch, discarding every comment already accumulated (TN.1/TN.3). Mirrors
     * that resilience: catch here, record why, and let the caller stop the loop gracefully instead
     * of throwing out of `review()`. Returns `null` on failure — the caller must check for that and
     * `break`. */
    async function completeSafely (maxOutputTokens: number): Promise<CompletionResponse | null> {
      try {
        return await ctx.provider.complete({
          system: systemPrompt,
          messages,
          tools: toolsForModel,
          maxOutputTokens,
          signal: ctx.signal
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (ctx.signal.aborted) {
          stopReason = 'aborted'
          notes.push('Agent review stopped early: the overall run timeout was reached.')
        } else {
          stopReason = 'provider_error'
          notes.push(`Agent review stopped: a provider call failed: ${message}`)
          logger.warning(`agent-engine: provider call failed: ${message}`)
        }
        return null
      }
    }

    while (true) {
      if (ctx.signal.aborted) {
        stopReason = 'aborted'
        notes.push('Agent review stopped early: the overall run timeout was reached.')
        break
      }
      if (iterations >= config.agent.max_iterations) {
        stopReason = 'iteration_limit'
        notes.push(
          `Agent review stopped: reached the iteration limit (${config.agent.max_iterations}) before finishing.`
        )
        break
      }
      if (promptTokens + completionTokens >= config.agent.token_budget) {
        stopReason = 'token_budget'
        notes.push(
          `Agent review stopped: reached the token budget (${config.agent.token_budget}) before finishing.`
        )
        break
      }
      if (budgetTrackable) {
        const costSoFar = Number(estimateCost({ promptTokens, completionTokens }, budgetPricing!))
        if (costSoFar >= config.budget.max_cost_usd!) {
          stopReason = 'budget_exceeded'
          notes.push(
            `Agent review stopped: reached the cost budget ($${config.budget.max_cost_usd}) before finishing.`
          )
          break
        }
      }

      iterations++
      debugLog(
        config.debug,
        `agent-engine: iteration ${iterations}/${config.agent.max_iterations} — ` +
          `${messages.length} message(s) in context`
      )

      const remainingIterations = config.agent.max_iterations - iterations + 1
      if (!nearLimitWarned && remainingIterations <= NEAR_ITERATION_LIMIT_WARNING) {
        nearLimitWarned = true
        debugLog(config.debug, `agent-engine: nudging the model to wrap up (${remainingIterations} iteration(s) left)`)
        messages.push({
          role: 'user',
          content: wrapUpNudge(
            `Only ${remainingIterations} iteration(s) remain before this review ends automatically.`
          )
        })
      }

      const remainingMs = deadlineAt - Date.now()
      if (!nearTimeLimitWarned && remainingMs <= config.api.total_timeout_ms * NEAR_TIME_LIMIT_REMAINING_FRACTION) {
        nearTimeLimitWarned = true
        debugLog(
          config.debug,
          `agent-engine: nudging the model to wrap up (~${Math.max(0, Math.round(remainingMs / 1000))}s left before the overall time budget)`
        )
        messages.push({
          role: 'user',
          content: wrapUpNudge('This review\'s overall time budget is almost exhausted.')
        })
      }

      const tokensUsedSoFar = promptTokens + completionTokens
      const remainingTokens = config.agent.token_budget - tokensUsedSoFar
      if (!nearTokenBudgetWarned && remainingTokens <= config.agent.token_budget * NEAR_TOKEN_BUDGET_REMAINING_FRACTION) {
        nearTokenBudgetWarned = true
        debugLog(
          config.debug,
          `agent-engine: nudging the model to wrap up (~${Math.max(0, remainingTokens)} token(s) left before the token budget)`
        )
        messages.push({
          role: 'user',
          content: wrapUpNudge('This review\'s overall token budget is almost exhausted.')
        })
      }

      const remainingToolCalls = config.agent.max_tool_calls - toolCallsMade
      if (
        !nearToolCallLimitWarned &&
        remainingToolCalls <= config.agent.max_tool_calls * NEAR_TOOL_CALL_LIMIT_REMAINING_FRACTION
      ) {
        nearToolCallLimitWarned = true
        debugLog(
          config.debug,
          `agent-engine: nudging the model to wrap up (${Math.max(0, remainingToolCalls)} tool call(s) left before the tool-call limit)`
        )
        messages.push({
          role: 'user',
          content: wrapUpNudge(
            `Only ${Math.max(0, remainingToolCalls)} tool call(s) remain before this review ends automatically.`
          )
        })
      }

      if (budgetTrackable && !nearCostBudgetWarned) {
        const costSoFar = Number(estimateCost({ promptTokens, completionTokens }, budgetPricing!))
        const remainingCost = config.budget.max_cost_usd! - costSoFar
        if (remainingCost <= config.budget.max_cost_usd! * NEAR_COST_BUDGET_REMAINING_FRACTION) {
          nearCostBudgetWarned = true
          debugLog(
            config.debug,
            `agent-engine: nudging the model to wrap up (~$${Math.max(0, remainingCost).toFixed(4)} left before the cost budget)`
          )
          messages.push({
            role: 'user',
            content: wrapUpNudge('This review\'s cost budget is almost exhausted.')
          })
        }
      }

      const firstResponse = await completeSafely(config.review.max_output_tokens)
      if (firstResponse === null) break
      let response = firstResponse
      accumulateUsage(response)
      logResponseDebug(`iteration ${iterations} response`, response)

      if (isInconclusiveTruncation(response)) {
        const retryMaxOutputTokens = config.review.max_output_tokens * TRUNCATED_RESPONSE_RETRY_MULTIPLIER
        debugLog(
          config.debug,
          `agent-engine: iteration ${iterations} response had no tool calls and no visible text ` +
            `(finishReason=${response.finishReason}) — retrying with a larger output budget ` +
            `(${config.review.max_output_tokens} -> ${retryMaxOutputTokens})`
        )
        const retryResponse = await completeSafely(retryMaxOutputTokens)
        if (retryResponse === null) break
        response = retryResponse
        accumulateUsage(response)
        logResponseDebug(`iteration ${iterations} retry response`, response)

        if (isInconclusiveTruncation(response)) {
          stopReason = 'response_truncated'
          notes.push(
            'Agent review stopped: the model returned no tool calls and no usable text, even after ' +
              'retrying with a larger output budget.'
          )
          break
        }
      }

      if (response.toolCalls.length === 0) {
        summary = (response.text ?? '').trim()
        stopReason = 'no_tool_calls'
        break
      }

      const finishCall = response.toolCalls.find((call) => call.name === 'finish')
      if (finishCall) {
        const args = (finishCall.arguments ?? {}) as Record<string, unknown>
        summary = typeof args.summary === 'string' ? args.summary : ''
        stopReason = 'finished'
        break
      }

      const signature = callSignature(response.toolCalls)
      const signatureCount = (signatureCounts.get(signature) ?? 0) + 1
      signatureCounts.set(signature, signatureCount)
      if (signatureCount >= REPEAT_ABORT_THRESHOLD) {
        stopReason = 'repeat_loop'
        notes.push(
          `Agent review stopped: the model repeated the exact same tool call ${REPEAT_ABORT_THRESHOLD} times.`
        )
        break
      }

      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls })

      for (const call of response.toolCalls) {
        if (toolCallsMade >= config.agent.max_tool_calls) {
          stopReason = 'tool_call_limit'
          toolCallLimitHit = true
          notes.push(
            `Agent review stopped: reached the tool-call limit (${config.agent.max_tool_calls}) before finishing.`
          )
          break
        }
        toolCallsMade++

        let content: string
        let isError: boolean
        if (call.argumentsError) {
          content = `Invalid tool call arguments: ${call.argumentsError}`
          isError = true
        } else {
          const handler = registry.handlers.get(call.name)
          if (!handler) {
            content = `Unknown tool "${call.name}". Available tools: ${[...registry.handlers.keys(), 'finish'].join(', ')}.`
            isError = true
          } else {
            try {
              const result = await handler(call.arguments, toolCtx)
              content = result.content
              isError = result.isError
            } catch (err) {
              content = `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`
              isError = true
            }
          }
        }
        debugLog(
          config.debug,
          `agent-engine: tool "${call.name}" ${isError ? 'returned an error' : 'completed'} — ` +
            `arguments=${truncateForLog(JSON.stringify(call.arguments ?? {}))}, ` +
            `result=${truncateForLog(content)}`
        )
        messages.push({ role: 'tool', content: wrapToolResult(content), toolCallId: call.id, name: call.name })
      }
      if (toolCallLimitHit) break

      if (signatureCount === REPEAT_WARNING_THRESHOLD) {
        messages.push({
          role: 'user',
          content:
            'You have called the exact same tool with the exact same arguments several times already. ' +
            'Try a different tool, different arguments, or call finish if you have enough information.'
        })
      }
    }

    debugLog(
      config.debug,
      `agent-engine: stopped (${stopReason}) after ${iterations} iteration(s), ${toolCallsMade} tool call(s), ` +
        `usage={prompt:${promptTokens},completion:${completionTokens}}`
    )

    // TW.4: one final turn, with the tool surface narrowed to `post_comment`/`finish`, to get what
    // the model already knows out of its head and onto the PR. Costs a single call against a run
    // that has already cost dozens, and only runs when that run would otherwise return nothing at
    // all — see `SALVAGEABLE_STOP_REASONS` for the stops deliberately left out.
    const postCommentSpec = registry.specs.find((spec) => spec.name === 'post_comment')
    const postCommentHandler = registry.handlers.get('post_comment')
    if (
      SALVAGEABLE_STOP_REASONS.has(stopReason) &&
      comments.findings.length === 0 &&
      !ctx.signal.aborted &&
      postCommentSpec !== undefined &&
      postCommentHandler !== undefined
    ) {
      answerDanglingToolCalls(messages)
      messages.push({
        role: 'user',
        content:
          'This review has now ended — no further exploration is possible. Report every finding you ' +
          'already have: call post_comment once per finding, all in this one turn, then call finish. ' +
          'If you genuinely found nothing worth flagging, just call finish and say so.'
      })
      debugLog(config.debug, 'agent-engine: last-chance turn — asking the model to post what it already has')

      // Not `completeSafely`: a failure here must not overwrite the real `stopReason` with
      // `provider_error`, which would misreport why the run actually ended.
      let salvage: CompletionResponse | null = null
      try {
        salvage = await ctx.provider.complete({
          system: systemPrompt,
          messages,
          tools: [postCommentSpec, FINISH_SPEC],
          maxOutputTokens: config.review.max_output_tokens,
          signal: ctx.signal
        })
      } catch (err) {
        logger.warning(
          `agent-engine: the last-chance turn failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }

      if (salvage !== null) {
        accumulateUsage(salvage)
        logResponseDebug('last-chance turn response', salvage)
        for (const call of salvage.toolCalls) {
          if (call.name === 'finish') {
            const args = (call.arguments ?? {}) as Record<string, unknown>
            if (typeof args.summary === 'string' && args.summary !== '') summary = args.summary
            continue
          }
          if (call.name !== 'post_comment' || call.argumentsError !== undefined) continue
          try {
            await postCommentHandler(call.arguments, toolCtx)
          } catch {
            // A malformed salvage call is not worth failing an already-truncated run over.
          }
        }
        notes.push(
          'Agent review was cut short before posting anything; a final turn recovered ' +
            `${comments.findings.length} finding(s).`
        )
      }
    }

    const truncated = stopReason !== 'finished' && stopReason !== 'no_tool_calls'
    const aggregatedCostUsd = everyCallHadCost && iterations > 0 ? costUsd : undefined

    // FR-53: opt-in, `mode: agent` only. Deliberately does NOT fold the filter
    // pass's own token usage into `promptTokens`/`completionTokens`/`costUsd` above — those
    // already assume a single price point (`budget.pricing`/the main model's real `costUsd`),
    // and the filter pass runs on a different (cheaper) model. Mixing the two would silently
    // corrupt `cost_estimate_usd` rather than just under-reporting it slightly.
    let finalFindings = comments.findings
    let findingsFiltered = 0
    if (ctx.filterProvider !== undefined && finalFindings.length > 0) {
      const filterResult = await filterNoise(finalFindings, ctx.filterProvider, ctx.signal)
      finalFindings = filterResult.kept
      findingsFiltered = filterResult.filteredCount
      if (filterResult.note) notes.push(filterResult.note)
    }

    return {
      summary: summary !== '' ? summary : defaultSummary(finalFindings),
      findings: [...finalFindings],
      usage: {
        promptTokens,
        completionTokens,
        estimated: anyEstimated,
        ...(aggregatedCostUsd !== undefined ? { costUsd: aggregatedCostUsd } : {})
      },
      notes,
      truncated,
      findingsFiltered
    }
  }
}
