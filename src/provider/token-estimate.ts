/**
 * Heuristic token-count estimator, used only when a provider response omits
 * `usage` (FR-24) and for pre-flight context budgeting (§7.4). Deliberately
 * NOT based on `tiktoken`: OpenAI's tokenizer is inaccurate for non-OpenAI
 * models (Anthropic/Gemini/self-hosted Qwen/Llama/etc. all use different
 * vocabularies) and especially inaccurate for code, so a real BPE tokenizer
 * would give a false sense of precision. Real numbers always come from the
 * provider's own `usage` field when available; this is a fallback estimate
 * only.
 *
 * Heuristic:
 * - ASCII characters cost ~4 chars/token for prose (rough industry rule of
 *   thumb) and ~3 chars/token for code (code is punctuation-dense —
 *   operators, brackets, indentation — which tends to tokenize more finely).
 *   "Code-like" is detected automatically from the density of common code
 *   punctuation, not from a caller-supplied flag.
 * - Non-ASCII characters (Cyrillic and other scripts) cost more tokens per
 *   character than ASCII — most BPE vocabularies are trained
 *   English/Latin-heavy, so other scripts fall back to shorter (sometimes
 *   byte-level) tokens. Modelled as ~1.6 chars/token.
 */

const CODE_PUNCTUATION_RE = /[{}()[\];:=+\-*/&|^%<>!~]/
/** Above this density of code-like punctuation, treat the text as code. */
const CODE_SYMBOL_RATIO_THRESHOLD = 0.08

const ASCII_PROSE_CHARS_PER_TOKEN = 4
const ASCII_CODE_CHARS_PER_TOKEN = 3
const NON_ASCII_CHARS_PER_TOKEN = 1.6

export function estimateTokens (text: string): number {
  if (text.length === 0) return 0

  let asciiCount = 0
  let nonAsciiCount = 0
  let symbolCount = 0

  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (codePoint <= 127) {
      asciiCount++
      if (CODE_PUNCTUATION_RE.test(ch)) symbolCount++
    } else {
      nonAsciiCount++
    }
  }

  const total = asciiCount + nonAsciiCount
  const symbolRatio = total > 0 ? symbolCount / total : 0
  const asciiCharsPerToken =
    symbolRatio > CODE_SYMBOL_RATIO_THRESHOLD
      ? ASCII_CODE_CHARS_PER_TOKEN
      : ASCII_PROSE_CHARS_PER_TOKEN

  const estimate = asciiCount / asciiCharsPerToken + nonAsciiCount / NON_ASCII_CHARS_PER_TOKEN
  return Math.ceil(estimate)
}
