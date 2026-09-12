/**
 * Test helper: temporarily set/unset environment variables for the duration
 * of a callback, restoring the previous values afterwards (even on throw).
 *
 * `withEnv` is for synchronous callbacks; `withEnvAsync` awaits the callback
 * before restoring env vars, which matters for `async` code under test that
 * may `await` before or after reading `process.env`.
 */

type EnvPatch = Record<string, string | undefined>

function apply (vars: EnvPatch): EnvPatch {
  const previous: EnvPatch = {}
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key]
    const value = vars[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  return previous
}

function restore (previous: EnvPatch): void {
  for (const key of Object.keys(previous)) {
    const value = previous[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

export function withEnv<T> (vars: EnvPatch, fn: () => T): T {
  const previous = apply(vars)
  try {
    return fn()
  } finally {
    restore(previous)
  }
}

export async function withEnvAsync<T> (vars: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const previous = apply(vars)
  try {
    return await fn()
  } finally {
    restore(previous)
  }
}
