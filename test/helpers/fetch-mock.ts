/**
 * Test helper: temporarily replace `globalThis.fetch` for the duration of a
 * callback, restoring the original afterwards (even on throw/rejection).
 *
 * `globalThis` is a plain mutable object (unlike a pure-ESM package's named
 * exports, see `secrets.ts`/`logger.ts` doc comments) so a direct property
 * assignment works fine here — no need for the `internals` seam pattern used
 * for `@actions/core`.
 *
 * `handler` receives the same arguments as `fetch` and must return something
 * assignable to `Response` (the real, global `Response` class is available
 * in Node 24 and is the easiest way to build one).
 */

type FetchArgs = Parameters<typeof fetch>
export type FetchHandler = (...args: FetchArgs) => Response | Promise<Response>

export async function withMockedFetch<T> (handler: FetchHandler, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((...args: FetchArgs) => handler(...args)) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Convenience: same as `withMockedFetch`, but also hands the callback a
 * counter of how many times `fetch` was invoked — several stage-3 tests
 * assert an exact call count (e.g. T3.33: exactly 2 HTTP requests for one
 * structured-output degradation step).
 */
export async function withMockedFetchCounting<T> (
  handler: FetchHandler,
  fn: (callCount: () => number) => Promise<T>
): Promise<T> {
  let count = 0
  return withMockedFetch(
    (...args) => {
      count++
      return handler(...args)
    },
    () => fn(() => count)
  )
}

/** Builds a JSON `Response` with the given status/body (defaults to 200). */
export function jsonResponse (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })
}

/** Builds a plain-text (non-JSON) `Response` — used to simulate gateway/HTML error pages. */
export function textResponse (
  body: string,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/html', ...init?.headers }
  })
}
