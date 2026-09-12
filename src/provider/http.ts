/**
 * Small HTTP helpers shared by every `ProviderAdapter` implementation
 * (`openai-compatible.ts`, `anthropic.ts`) — none of this is OpenAI- or
 * Anthropic-specific, it's just URL joining, `Retry-After` parsing and
 * bounded-length snippeting for error messages.
 */

export function truncate (text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…(truncated)` : text
}

export function joinUrl (baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/** Parses an HTTP `Retry-After` header value, which is either a number of
 * seconds or an HTTP-date. Returns `undefined` for anything else. */
export function parseRetryAfterMs (headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const seconds = Number(headerValue)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const dateMs = Date.parse(headerValue)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}
