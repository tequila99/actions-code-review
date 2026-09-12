/**
 * Tool-calling capability probe (FR-26, §11.6). Sends an actual trivial tool
 * and checks whether the response comes back as a real `tool_calls` entry,
 * which is the one thing `mode: agent` cannot work without.
 */

import { logger } from '../util/logger.ts'
import { CapabilityError } from '../util/errors.ts'
import type { CompletionResponse, ProviderAdapter, ToolSpec } from './types.ts'

const ECHO_TOOL_SPEC: ToolSpec = {
  name: 'echo',
  description: 'Echo back the given text. Used only to probe tool-calling support.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  }
}

/** Reasoning-family models (o1/o3/gpt-5, etc.) spend hidden reasoning tokens out of the same
 * completion budget before ever emitting the tool call — a too-small budget makes a model that
 * genuinely supports tool calling look like it doesn't. Empirically (MWS-hosted gpt-5), that
 * reasoning-token spend on this trivial probe varies wildly call-to-call (observed: 128, 448,
 * 512, 768+) — no single fixed budget is reliably safe, hence the retry below rather than just a
 * bigger constant (TK.1/TK.2). */
const PROBE_MAX_OUTPUT_TOKENS = 512
const PROBE_RETRY_MAX_OUTPUT_TOKENS = 2000

/** One probe result per provider *instance* for the lifetime of the process
 * (T7.53 — "one check per job"; a single action run only ever constructs
 * one `ProviderAdapter`, so this is effectively per-run). Keyed by the
 * adapter object itself so unrelated tests/providers never share a cached
 * result. */
const cache = new WeakMap<ProviderAdapter, Promise<boolean>>()

function probeOnce (
  provider: ProviderAdapter,
  signal: AbortSignal,
  maxOutputTokens: number
): Promise<CompletionResponse> {
  return provider.complete({
    system: 'You are a capability probe. Call the echo tool with text "ok", nothing else.',
    messages: [{ role: 'user', content: 'probe' }],
    tools: [ECHO_TOOL_SPEC],
    maxOutputTokens,
    signal
  })
}

async function runProbe (provider: ProviderAdapter, signal: AbortSignal): Promise<boolean> {
  try {
    const first = await probeOnce(provider, signal, PROBE_MAX_OUTPUT_TOKENS)
    if (first.toolCalls.some((call) => call.name === 'echo')) return true
    // `finishReason: 'length'` with no tool_calls is inconclusive (cut off before finishing, see
    // above), not proof of no support — retry once with a much larger budget (TK.2/TK.3). Any
    // other finish reason (e.g. 'stop' with plain text) is a clean, unambiguous "no" (TK.4).
    if (first.finishReason !== 'length') return false
    const retry = await probeOnce(provider, signal, PROBE_RETRY_MAX_OUTPUT_TOKENS)
    return retry.toolCalls.some((call) => call.name === 'echo')
  } catch {
    return false
  }
}

/** Never throws — a network/provider failure (T7.55) is indistinguishable
 * from "the model didn't call the tool" (T7.50) as far as this function is
 * concerned; both resolve to `false`. Mode-specific handling of that
 * `false` (error vs. silent fallback) is `ensureAgentModeSupported`'s job. */
export function probeToolCalling (provider: ProviderAdapter, signal: AbortSignal): Promise<boolean> {
  const cached = cache.get(provider)
  if (cached !== undefined) return cached
  const probe = runProbe(provider, signal)
  cache.set(provider, probe)
  return probe
}

const CAPABILITY_HINT =
  'For vLLM, start the server with --enable-auto-tool-choice --tool-call-parser <parser> matching ' +
  'the model\'s chat template. Otherwise, use mode: "diff" instead.'

/**
 * `mode: agent` -> probes and throws a diagnosable `CapabilityError` if the
 * model can't do tool calling (T7.51/T7.55). `mode: auto` -> probes and
 * silently falls back (the caller is expected to switch to `DiffEngine`
 * itself; this only decides + logs, T7.52/T7.55). `mode: diff` -> never
 * called at all by `selector.ts` (T7.54), so it isn't handled here.
 */
export async function ensureAgentModeSupported (
  provider: ProviderAdapter,
  signal: AbortSignal,
  mode: 'agent' | 'auto'
): Promise<boolean> {
  const supported = await probeToolCalling(provider, signal)
  if (supported) return true

  if (mode === 'agent') {
    throw new CapabilityError(
      'mode: "agent" requires tool calling, but the configured model/endpoint did not return ' +
        'tool_calls for a trivial probe request.',
      CAPABILITY_HINT
    )
  }

  logger.warning(
    'mode: "auto" — the model/endpoint does not support tool calling; falling back to mode: "diff".'
  )
  return false
}
