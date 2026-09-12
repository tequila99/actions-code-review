import { ProviderError } from '../util/errors.ts'

/**
 * Thrown by the single-attempt function passed to `withRetry` for any
 * non-2xx HTTP response. Carries the status code (and, when present, the
 * parsed `Retry-After` header and a redacted/truncated body snippet) so
 * `withRetry` can classify retryability and `structured-output.ts` (the
 * layer above) can inspect the body to decide on a degradation step —
 * `retry.ts` itself never looks at `bodyText`, only at `status` (§7.1 PRD:
 * "retry.ts ретраит 408/429/5xx/сеть; 400 НЕ ретраит, пробрасывает вверх").
 *
 * Extends `ProviderError` rather than a bespoke class per the stage-3 brief
 * ("используй `ProviderError`, не создавай новый класс, если он подходит")
 * — every error this module and `openai-compatible.ts` throw ends up an
 * `instanceof ProviderError` all the way up to the caller.
 */
export class HttpStatusError extends ProviderError {
  readonly status: number
  readonly retryAfterMs?: number
  readonly bodyText?: string

  constructor (
    status: number,
    message: string,
    opts?: { retryAfterMs?: number; bodyText?: string; hint?: string }
  ) {
    super(message, opts?.hint)
    this.name = 'HttpStatusError'
    this.status = status
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
    if (opts?.bodyText !== undefined) this.bodyText = opts.bodyText
  }
}

/** Thrown once the retry budget (`maxAttempts`) is exhausted (T3.24). */
export class RetryExhaustedError extends ProviderError {
  readonly attempts: number
  readonly lastStatus?: number

  constructor (attempts: number, lastError: unknown, lastStatus?: number) {
    const lastMessage = lastError instanceof Error ? lastError.message : String(lastError)
    const statusPart = lastStatus !== undefined ? ` (last HTTP status ${lastStatus})` : ''
    super(`Giving up after ${attempts} attempt(s)${statusPart}: ${lastMessage}`)
    this.name = 'RetryExhaustedError'
    this.attempts = attempts
    if (lastStatus !== undefined) this.lastStatus = lastStatus
  }
}

export interface RetryOptions {
  /** Total number of attempts, including the first one. Default 4. */
  maxAttempts?: number
  /** Base delay for exponential backoff, in ms. Default 300. */
  baseDelayMs?: number
  /** Cap on the computed backoff delay (before `Retry-After` is applied), in ms. Default 10000. */
  maxDelayMs?: number
  /** Aborts the whole retry loop immediately, including any pending wait (T3.28). */
  signal?: AbortSignal
  /** Injectable for tests — must NOT actually sleep in test code. Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable jitter source for tests. Default `Math.random`. */
  random?: () => number
}

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 300
const DEFAULT_MAX_DELAY_MS = 10_000

function defaultSleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `AbortSignal.timeout()`/manual-abort errors surface as `TimeoutError`/`AbortError` (DOMException
 * on real `fetch`, a plain `Error` with that `.name` in tests). Whether one of these is retryable
 * depends on *which* signal fired — see the `signal?.aborted` check in `withRetry`. */
function isAbortError (err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE'
])

function hasStringCode (err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  )
}

/**
 * A "network error" is a low-level transport failure (connection
 * reset/refused, DNS failure, etc.) — always retryable (FR-22). Anything
 * else that isn't an `HttpStatusError` (e.g. a JSON-parse failure, a
 * "no choices in response" logical error) is deliberately NOT retried:
 * retrying a malformed-response error rarely helps and risks masking a real
 * bug as slow flakiness.
 */
function isNetworkError (err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (hasStringCode(err)) return NETWORK_ERROR_CODES.has(err.code)
  return false
}

const RETRYABLE_EXTRA_STATUSES = new Set([408, 429])

function isRetryableStatus (status: number): boolean {
  return RETRYABLE_EXTRA_STATUSES.has(status) || (status >= 500 && status <= 599)
}

/**
 * Runs `attempt` (a function performing exactly one HTTP call) with
 * exponential-backoff-with-jitter retries on 408/429/5xx responses, network
 * errors, and per-request timeouts (FR-22). Honors `Retry-After` when
 * present on an `HttpStatusError`. Does NOT retry 400/401/403/other
 * non-listed 4xx statuses, or anything else that isn't recognized as a
 * network/timeout error — those are rethrown immediately to the caller
 * (§7.1: this module never interprets 400, that's `structured-output.ts`'s
 * job). A `TimeoutError`/`AbortError` while the caller's `signal` is already
 * aborted means the *run-level* budget (not this one request) expired —
 * that is never retried, since another attempt would just abort again.
 */
export async function withRetry<T> (
  attempt: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const signal = options.signal

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
    }

    try {
      return await attempt()
    } catch (err) {
      // `signal` is the caller's run-level budget (e.g. total_timeout_ms) —
      // once *that* has expired, retrying is pointless (it would just abort
      // again). A `TimeoutError`/`AbortError` while `signal` is NOT aborted
      // means only the per-request timeout fired, which is transient and
      // worth retrying like any other network hiccup (FR-22).
      if (signal?.aborted) {
        throw err
      }

      const status = err instanceof HttpStatusError ? err.status : undefined
      const retryable =
        status !== undefined ? isRetryableStatus(status) : isAbortError(err) || isNetworkError(err)
      if (!retryable) {
        throw err
      }

      if (attemptNumber === maxAttempts) {
        throw new RetryExhaustedError(attemptNumber, err, status)
      }

      const retryAfterMs = err instanceof HttpStatusError ? err.retryAfterMs : undefined
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attemptNumber - 1))
      const jitter = backoff * 0.5 * random()
      const delayMs = Math.max(backoff + jitter, retryAfterMs ?? 0)
      await sleep(delayMs)
    }
  }

  // Unreachable: the loop above always returns or throws.
  throw new RetryExhaustedError(maxAttempts, new Error('withRetry: exhausted without an error'))
}
