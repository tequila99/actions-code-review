import type { DiffFile, DiffHunk, DiffLine } from './diff-parse.ts'

/** Clamped, matching `filters.context_lines` (T1.55, `config/schema.ts`: 0..30). */
function clampContextLines (contextLines: number): number {
  if (!Number.isFinite(contextLines)) return 3
  return Math.min(30, Math.max(0, Math.trunc(contextLines)))
}

/**
 * For each line, decides whether it should be shown given `contextLines`:
 * every `add`/`del` line is always shown; a `context` line is shown only if
 * it is within `contextLines` positions of some change. Deterministic (pure
 * function of the input array), used to trim large hunks down for the model
 * without losing the lines immediately around a change.
 */
function computeVisibility (lines: readonly DiffLine[], contextLines: number): boolean[] {
  const visible = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type === 'context') continue
    visible[i] = true
    for (let d = 1; d <= contextLines; d++) {
      if (i - d >= 0) visible[i - d] = true
      if (i + d < lines.length) visible[i + d] = true
    }
  }
  return visible
}

function formatLine (line: DiffLine): string {
  if (line.type === 'add') {
    return `+${String(line.newLineNumber).padStart(6, ' ')} | ${line.content}`
  }
  if (line.type === 'del') return `-${' '.repeat(6)} | ${line.content}`
  return ` ${String(line.newLineNumber).padStart(6, ' ')} | ${line.content}`
}

function isPureDeletion (lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.type === 'del') && !lines.some((l) => l.type === 'add')
}

/**
 * Renders one hunk for the model prompt (FR-30): every kept line is
 * prefixed with its new-version line number; deleted lines are marked but
 * carry no new-version number (there isn't one). `contextLines` (default 3,
 * 0..10 per config) controls how much unchanged context around each change
 * is kept — everything else is collapsed into a single "N lines omitted"
 * marker so large hunks don't blow up the prompt. A hunk that is purely
 * deletions is rendered as a compact one-line summary instead of dumping
 * every removed line (`handle_patch_deletions`, PRD §7.4/T2.34).
 */
export function renderHunk (hunk: DiffHunk, contextLines = 3): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`

  if (isPureDeletion(hunk.lines)) {
    return `${header}\n(purely deleting change: ${hunk.oldLines} line(s) removed, nothing added)`
  }

  const n = clampContextLines(contextLines)
  const visible = computeVisibility(hunk.lines, n)

  const out: string[] = [header]
  let omitted = 0
  for (let i = 0; i < hunk.lines.length; i++) {
    if (!visible[i]) {
      omitted++
      continue
    }
    if (omitted > 0) {
      out.push(`  ⋯ ${omitted} line(s) omitted ⋯`)
      omitted = 0
    }
    out.push(formatLine(hunk.lines[i]!))
  }
  if (omitted > 0) out.push(`  ⋯ ${omitted} line(s) omitted ⋯`)

  return out.join('\n')
}

/** Renders every hunk of a file, in order, joined by a blank line. */
export function renderFile (file: DiffFile, contextLines = 3): string {
  if (file.binary) return `(binary file, not rendered: ${file.path})`
  return file.hunks.map((hunk) => renderHunk(hunk, contextLines)).join('\n\n')
}
