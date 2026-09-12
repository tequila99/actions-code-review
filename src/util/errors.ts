import { redact } from './secrets.ts'

/**
 * Base class for typed, user-facing errors raised anywhere in the action.
 * `toUserMessage()` is the single place that turns an internal error into
 * text that is safe to hand to `core.setFailed()` / `core.error()`: it
 * appends the optional `hint` and always runs the result through
 * `redact()` (THR-1/THR-2 — an error message is exactly the kind of place a
 * secret accidentally ends up, e.g. a provider's raw HTTP error body).
 */
export abstract class AppError extends Error {
  abstract readonly code: string
  readonly hint?: string

  constructor (message: string, hint?: string) {
    super(message)
    this.name = new.target.name
    if (hint !== undefined) this.hint = hint
  }

  toUserMessage (): string {
    const text = this.hint ? `${this.message}\n${this.hint}` : this.message
    return redact(text)
  }
}

/** Raised for anything wrong with inputs / `.github/code-review.yml` / merged config. */
export class ConfigError extends AppError {
  readonly code = 'CONFIG_ERROR'
}

/** Raised for anything wrong with an upstream LLM provider call (used from stage 3+). */
export class ProviderError extends AppError {
  readonly code = 'PROVIDER_ERROR'
}

/**
 * Raised when `mode: agent`'s capability probe (FR-26) finds the configured
 * model/endpoint does not support tool calling. Deliberately its own
 * subclass (not `ProviderError`) so a caller can distinguish "the model
 * can't do agent mode" from a generic provider failure and map it to the
 * dedicated `skipped_reason: 'capability_check_failed'` output (§8.2) —
 * that mapping itself is main.ts wiring, out of scope for stage 7.
 */
export class CapabilityError extends AppError {
  readonly code = 'CAPABILITY_CHECK_FAILED'
}

/**
 * Raised for anything wrong with a GitHub API interaction: missing/malformed
 * event payload (`github/context.ts`), a diff GitHub refuses to return
 * (`github/diff.ts`), or (from stage 5) publishing a review.
 */
export class GithubApiError extends AppError {
  readonly code = 'GITHUB_API_ERROR'
}
