import type { DiffFile } from './diff-parse.ts'

/**
 * PRD §7.5, layer 1 of the 3-layer position-validation defense: GitHub's
 * Reviews API rejects the **entire** review with a 422 if a single inline
 * comment points at a line outside the diff. `PositionMap` is the single
 * source of truth for "can we legally comment on (path, line)".
 */
export interface PositionMap {
  /** True if `line` (new-version line number) is commentable in `path`. */
  isValid(path: string, line: number): boolean
  /**
   * Validates a multi-line comment range. `endLine` (the GitHub `line`
   * field) is the anchor: if it is invalid there is nothing to comment on
   * and `null` is returned. If `endLine` is valid but `startLine` is not,
   * the range collapses to a single line at `endLine` (PRD §7.5). If
   * `endLine < startLine` the pair is normalized (swapped) first, so an
   * inverted range never throws.
   */
  validateRange(path: string, startLine: number, endLine: number): ValidatedRange | null
}

export interface ValidatedRange {
  startLine: number
  endLine: number
}

/**
 * Builds the map of `path -> Set<new-version line numbers>` that may be
 * commented on: every `add` and `context` line of every hunk (not just
 * additions — a comment can legally anchor on unchanged context too),
 * never `del` lines. Binary files contribute nothing (they have no hunks).
 */
export function buildPositionMap (files: readonly DiffFile[]): PositionMap {
  const map = new Map<string, Set<number>>()

  for (const file of files) {
    if (file.binary) continue
    let lines = map.get(file.path)
    if (!lines) {
      lines = new Set<number>()
      map.set(file.path, lines)
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if ((line.type === 'add' || line.type === 'context') && line.newLineNumber !== undefined) {
          lines.add(line.newLineNumber)
        }
      }
    }
  }

  function isValid (path: string, line: number): boolean {
    return map.get(path)?.has(line) ?? false
  }

  function validateRange (path: string, startLine: number, endLine: number): ValidatedRange | null {
    const [lo, hi] = startLine <= endLine ? [startLine, endLine] : [endLine, startLine]
    if (!isValid(path, hi)) return null
    if (!isValid(path, lo)) return { startLine: hi, endLine: hi }
    return { startLine: lo, endLine: hi }
  }

  return { isValid, validateRange }
}
