import * as core from '@actions/core'
import { redact } from './secrets.ts'

/**
 * Mutable seam for tests, same rationale as `secrets.ts`/`main.ts`:
 * `@actions/core`'s named exports are immutable ESM live bindings and
 * cannot be patched with `t.mock.method(core, 'info', ...)`. All the rest
 * of the codebase should call `logger.*` (below), never `core.*` directly,
 * so that mocking a single seam (`logger` here, or `internals` from this
 * module's own tests) is enough everywhere.
 */
export const internals = {
  info (message: string): void {
    core.info(message)
  },
  warning (message: string): void {
    core.warning(message)
  },
  debug (message: string): void {
    core.debug(message)
  },
  error (message: string): void {
    core.error(message)
  },
  startGroup (name: string): void {
    core.startGroup(name)
  },
  endGroup (): void {
    core.endGroup()
  }
}

// Matches an http(s) URL up to the first character that cannot legally be
// part of one (whitespace or common surrounding punctuation/quoting).
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g

/**
 * Strips userinfo (`user:pass@`) and query strings from any URL found in
 * `text`, so that URLs can be logged for audit purposes without leaking an
 * API key embedded as `?key=...` or `user:pass@host` (THR-7).
 */
export function sanitizeUrls (text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match)
      url.username = ''
      url.password = ''
      url.search = ''
      return url.toString()
    } catch {
      return match
    }
  })
}

function prepare (message: string): string {
  return redact(sanitizeUrls(message))
}

/** How much of a single field (prompt, tool output, diff hunk) a debug log line keeps before
 * clipping — bounds Actions log size when `config.debug: true` dumps model I/O. */
const DEBUG_LOG_MAX_LENGTH = 20000

/** Clips `text` to `maxLength`, appending a marker so a truncated debug field never reads as
 * complete. Not a redaction step by itself — callers still go through `debugLog`/`logger.info`,
 * which redacts registered secrets regardless of length. */
export function truncateForLog (text: string, maxLength: number = DEBUG_LOG_MAX_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…(truncated)` : text
}

function endGroupSafely (): void {
  internals.endGroup()
}

/**
 * Thin, redaction-safe wrapper over `@actions/core`'s logging API (FR-72,
 * THR-1). Every message passed through `logger.*` is sanitized (URLs) and
 * redacted (registered secrets) before it reaches `core.*`.
 */
export const logger = {
  info (message: string): void {
    internals.info(prepare(message))
  },
  warning (message: string): void {
    internals.warning(prepare(message))
  },
  debug (message: string): void {
    internals.debug(prepare(message))
  },
  error (message: string): void {
    internals.error(prepare(message))
  },
  /**
   * Runs `fn` inside a `core.startGroup`/`core.endGroup` pair. `endGroup`
   * is always called, including when `fn` throws or returns a rejecting
   * promise (FR-72).
   */
  group<T> (name: string, fn: () => T): T {
    internals.startGroup(prepare(name))
    let result: T
    try {
      result = fn()
    } catch (error) {
      endGroupSafely()
      throw error
    }
    if (result instanceof Promise) {
      return result.finally(endGroupSafely) as unknown as T
    }
    endGroupSafely()
    return result
  }
}

/**
 * Extended, `config.debug`-gated diagnostic line (FR-73): per-iteration/per-tool-call traces from
 * `DiffEngine`/`AgentEngine`. Routed through `logger.info` — not `logger.debug`/`core.debug`, which
 * stays invisible in the Actions UI unless the *repository* separately sets its own
 * `ACTIONS_STEP_DEBUG` secret. A user who sets this action's own `debug: true` input expects to see
 * output without also having to discover that unrelated GitHub-level toggle.
 */
export function debugLog (enabled: boolean, message: string): void {
  if (enabled) logger.info(`[debug] ${message}`)
}
