import * as core from '@actions/core'

/**
 * Values shorter than this are ignored by `registerSecret`: masking a
 * short/common substring (e.g. a 1-3 char value) would corrupt unrelated
 * log output.
 */
const MIN_SECRET_LENGTH = 4

/**
 * Mutable seam for tests. `@actions/core` is a pure ESM package whose named
 * exports are immutable live bindings — `t.mock.method(core, 'setSecret', ...)`
 * throws "Cannot redefine property". Wrapping the call in a plain, mutable
 * object lets tests replace it with `t.mock.method(internals, 'setSecret', ...)`
 * (same pattern as `src/main.ts`).
 */
export const internals = {
  setSecret (value: string): void {
    core.setSecret(value)
  }
}

const registeredSecrets = new Set<string>()

/**
 * Registers a value to be masked by `redact()` and by the Actions runner
 * (`core.setSecret`). Empty/undefined/null values and values shorter than
 * `MIN_SECRET_LENGTH` are silently ignored — registering them would either
 * do nothing useful or corrupt unrelated text once redacted.
 */
export function registerSecret (value: string | undefined | null): void {
  if (value === undefined || value === null || value === '') return
  if (value.length < MIN_SECRET_LENGTH) return
  if (registeredSecrets.has(value)) return
  registeredSecrets.add(value)
  internals.setSecret(value)
}

/** Replaces every registered secret value found in `text` with `***`. */
export function redact (text: string): string {
  if (registeredSecrets.size === 0) return text
  let result = text
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('***')
  }
  return result
}
