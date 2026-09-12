/**
 * Дополнение B (пост-v0.1): автоопределение `review.language` по заголовку
 * PR, когда язык нигде не задан явно (ни `language` input, ни
 * `review.language` в `.github/code-review.yml`). Only `en`/`ru` are
 * distinguished for now (PRD FR-37, пересмотренный).
 */

const CYRILLIC_LETTER_PATTERN = /[а-яё]/gi
const LATIN_LETTER_PATTERN = /[a-z]/gi

/**
 * A conservative heuristic: `title` is treated as Russian only when it has
 * at least 2 Cyrillic letters *and* strictly more Cyrillic letters than
 * Latin letters. Anything below that confidence threshold (no letters, a
 * single stray Cyrillic letter, a Cyrillic/Latin tie, pure Latin) is `false`
 * — callers fall back to the configured default language instead.
 */
export function looksRussian (title: string): boolean {
  const cyrillicCount = title.match(CYRILLIC_LETTER_PATTERN)?.length ?? 0
  const latinCount = title.match(LATIN_LETTER_PATTERN)?.length ?? 0
  return cyrillicCount >= 2 && cyrillicCount > latinCount
}

export interface ResolveReviewLanguageParams {
  /** `review.language` when it was explicitly set by input or file (see
   * `config/merge.ts#isLanguageExplicit`), `undefined` otherwise. */
  explicitLanguage: string | undefined
  prTitle: string
  defaultLanguage: string
}

/**
 * Priority: an explicit `language` (input or `.github/code-review.yml`)
 * always wins and skips detection entirely; otherwise a confidently-Russian
 * PR title resolves to `'ru'`; otherwise `defaultLanguage` (normally
 * `DEFAULTS.language`, i.e. `'en'`).
 */
export function resolveReviewLanguage (params: ResolveReviewLanguageParams): string {
  if (params.explicitLanguage !== undefined) return params.explicitLanguage
  if (looksRussian(params.prTitle)) return 'ru'
  return params.defaultLanguage
}
