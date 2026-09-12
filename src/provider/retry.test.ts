import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry, HttpStatusError, RetryExhaustedError, defaultSleep } from './retry.ts'

/** Records every delay `withRetry` asked to wait, without ever actually waiting. */
function fakeSleep (): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    }
  }
}

function networkError (code: string): Error & { code: string } {
  return Object.assign(new TypeError('fetch failed'), { code })
}

test('T3.19: 429 then 200 succeeds after exactly 2 attempts', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw new HttpStatusError(429, 'rate limited')
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('T3.20: 500 -> 503 -> 200 succeeds after exactly 3 attempts', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw new HttpStatusError(500, 'server error')
      if (calls === 2) throw new HttpStatusError(503, 'unavailable')
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('T3.21: 400 is not retried, the error is thrown to the caller after exactly 1 attempt', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++
          throw new HttpStatusError(400, 'bad request')
        },
        { sleep }
      ),
    (err: unknown) => err instanceof HttpStatusError && err.status === 400
  )
  assert.equal(calls, 1)
})

test('T3.22: 401/403 are not retried', async () => {
  for (const status of [401, 403]) {
    const { sleep } = fakeSleep()
    let calls = 0
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls++
          throw new HttpStatusError(status, 'auth error')
        },
        { sleep }
      )
    )
    assert.equal(calls, 1, `status ${status} must not be retried`)
  }
})

test('T3.23: 408 is retried (FR-22)', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw new HttpStatusError(408, 'request timeout')
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('T3.24: attempt exhaustion throws an error with the attempt count and last status', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++
          throw new HttpStatusError(503, 'unavailable')
        },
        { sleep, maxAttempts: 3 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError)
      assert.equal(err.attempts, 3)
      assert.equal(err.lastStatus, 503)
      assert.match(err.message, /3 attempt/)
      assert.match(err.message, /503/)
      return true
    }
  )
  assert.equal(calls, 3)
})

test('T3.25: Retry-After: 5 forces a delay of at least 5000ms (mocked sleep, test does not sleep)', async () => {
  const { sleep, delays } = fakeSleep()
  let calls = 0
  await withRetry(
    async () => {
      calls++
      if (calls === 1) throw new HttpStatusError(429, 'rate limited', { retryAfterMs: 5000 })
      return 'ok'
    },
    { sleep, baseDelayMs: 10 }
  )
  assert.equal(delays.length, 1)
  const [delay] = delays as [number]
  assert.ok(delay >= 5000, `expected delay >= 5000ms, got ${delay}`)
})

test('T3.26: exponential backoff with jitter — delays grow across attempts and jitter is not 0', async () => {
  const { sleep, delays } = fakeSleep()
  let calls = 0
  await withRetry(
    async () => {
      calls++
      if (calls < 3) throw new HttpStatusError(500, 'server error')
      return 'ok'
    },
    { sleep, baseDelayMs: 100, random: () => 0.5 }
  )
  assert.equal(delays.length, 2)
  const [first, second] = delays as [number, number]
  assert.ok(second > first, `expected delays to grow: ${first} then ${second}`)
  // Pure exponential backoff (no jitter) would be exactly 100 then 200.
  assert.notEqual(first, 100, 'jitter must not be 0')
  assert.notEqual(second, 200, 'jitter must not be 0')
})

test('T3.27: a network error (ECONNRESET) is retried', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw networkError('ECONNRESET')
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('T3.28: an already-aborted AbortSignal stops retries immediately, no attempt is made', async () => {
  const { sleep } = fakeSleep()
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  let calls = 0
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++
        return 'ok'
      },
      { sleep, signal: controller.signal }
    )
  )
  assert.equal(calls, 0)
})

test('T3.28b: a TimeoutError thrown mid-attempt IS retried when no run-level signal is aborted', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) {
        const err = new Error('timed out')
        err.name = 'TimeoutError'
        throw err
      }
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('TH.1: an AbortError thrown mid-attempt IS retried when no run-level signal is aborted', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      return 'ok'
    },
    { sleep }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('TH.2: a TimeoutError is NOT retried when the run-level signal is aborted concurrently (the overall budget, not this one request, is what expired)', async () => {
  const { sleep } = fakeSleep()
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++
          controller.abort(new Error('run timed out'))
          const err = new Error('timed out')
          err.name = 'TimeoutError'
          throw err
        },
        { sleep, signal: controller.signal }
      ),
    (err: unknown) => err instanceof Error && err.name === 'TimeoutError'
  )
  assert.equal(calls, 1)
})

test('TAC1: defaultSleep resolves after the delay when not aborted (#10a)', async () => {
  const start = Date.now()
  await defaultSleep(20)
  assert.ok(Date.now() - start >= 15, 'defaultSleep should wait roughly the requested duration')
})

test('TAC2: defaultSleep rejects immediately with signal.reason when the signal is already aborted (#10a)', async () => {
  const controller = new AbortController()
  const reason = new Error('already aborted')
  controller.abort(reason)
  await assert.rejects(() => defaultSleep(1000, controller.signal), (err: unknown) => err === reason)
})

test('TAC3: defaultSleep rejects with signal.reason as soon as the signal aborts mid-wait (#10a)', async () => {
  const controller = new AbortController()
  const reason = new Error('aborted mid-wait')
  const start = Date.now()
  setTimeout(() => controller.abort(reason), 10)
  await assert.rejects(() => defaultSleep(10_000, controller.signal), (err: unknown) => err === reason)
  assert.ok(Date.now() - start < 1000, 'abort should cancel the pending timer, not wait out the full delay')
})

test('TAC4: withRetry using the real default sleep aborts a pending backoff wait as soon as the run-level signal fires (#10a)', async () => {
  const controller = new AbortController()
  const reason = new Error('run budget expired')
  let calls = 0
  const start = Date.now()
  const promise = withRetry(
    async () => {
      calls++
      throw new HttpStatusError(503, 'unavailable')
    },
    { signal: controller.signal, baseDelayMs: 10_000, maxAttempts: 5 }
  )
  setTimeout(() => controller.abort(reason), 10)
  await assert.rejects(() => promise, (err: unknown) => err === reason)
  assert.equal(calls, 1)
  assert.ok(Date.now() - start < 1000, 'the pending backoff wait should be cancelled, not waited out')
})

test('TAC5: a Retry-After far above the cap is clamped to maxDelayMs * 6 (#10b)', async () => {
  const { sleep, delays } = fakeSleep()
  let calls = 0
  await withRetry(
    async () => {
      calls++
      if (calls === 1) {
        throw new HttpStatusError(429, 'rate limited', { retryAfterMs: 10_000_000 })
      }
      return 'ok'
    },
    { sleep, maxDelayMs: 10_000 }
  )
  assert.equal(delays.length, 1)
  const [delay] = delays as [number]
  assert.equal(delay, 60_000)
})

test('TH.3: repeated TimeoutErrors exhaust the retry budget like any other retryable error', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++
          const err = new Error('timed out')
          err.name = 'TimeoutError'
          throw err
        },
        { sleep, maxAttempts: 3 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError)
      assert.equal(err.attempts, 3)
      return true
    }
  )
  assert.equal(calls, 3)
})
