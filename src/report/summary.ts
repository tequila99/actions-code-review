import { redact } from '../util/secrets.ts'

/**
 * Hard cap (chars) on the model's summary once it is published in the sticky comment. The prompt
 * asks for far less (`SUMMARY_LENGTH_HINT`) — this is the backstop for a model that ignores it.
 */
export const SUMMARY_MAX_CHARS = 3000

/** Length guidance the prompts give the model; keep well below `SUMMARY_MAX_CHARS`. */
export const SUMMARY_LENGTH_HINT = '2-3 short paragraphs, about 1500 characters at most'

const ZWSP = '​'

/**
 * Removes HTML comments/tags/declarations. Repeats until stable because stripping can *form* new
 * markup (`<<b>!-- x -->` becomes a comment once `<b>` is gone); whatever is left is escaped so a
 * forged `<!--` can never survive — it would corrupt the entry delimiters `buildStickyBody` scans.
 */
function stripHtml (text: string): string {
  let out = text
  for (let i = 0; i < 10; i++) {
    const next = out
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<![^>]*>?/g, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    if (next === out) break
    out = next
  }
  return out.replace(/<!--/g, '&lt;!--')
}

/** Cuts to `SUMMARY_MAX_CHARS`, never leaving an inline code span open or a split surrogate pair. */
function clip (text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text
  let cut = text.slice(0, SUMMARY_MAX_CHARS - 2)
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  cut = cut.trimEnd()
  if (((cut.match(/`/g) ?? []).length) % 2 === 1) cut += '`'
  return `${cut}…`
}

/**
 * Makes the model's free-text summary safe to embed in a GitHub comment. It is untrusted output
 * (it can quote PR content verbatim), so: HTML/comments are stripped, images and link targets
 * dropped (no exfiltration URLs), @mentions defanged (no pings), code fences flattened and
 * line-leading `#`/`---`/`===` escaped (it must not open headings that confuse
 * `trimEntryToBudget`), registered secrets redacted, and the result clipped to
 * `SUMMARY_MAX_CHARS`. Inline code is left alone — quoting an identifier is the common case.
 */
export function sanitizeSummary (raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n')
  text = stripHtml(text)
  text = text
    .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@(?=[A-Za-z0-9])/g, `@${ZWSP}`)
    .replace(/`{3,}/g, '`')
    .replace(/~{3,}/g, '~')
    .replace(/^([ \t]*)(#{1,6})(?=\s|$)/gm, '$1\\$2')
    .replace(/^([ \t]*)([-=]{2,})[ \t]*$/gm, '$1\\$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return clip(redact(text))
}
