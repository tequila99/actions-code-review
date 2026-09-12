/**
 * Unified diff parser for the text GitHub returns from `pulls.get`/
 * `repos.compareCommits` with `mediaType: {format: 'diff'}`, and for a single
 * file's `patch` field from `pulls.listFiles` (via `parseHunks`).
 *
 * Q-2 (PRD §6, IMPLEMENTATION_PLAN.md Этап 2): a hand-written parser was
 * chosen over the `parse-diff` npm package. All edge cases in T2.10-T2.23
 * pass and the implementation stays close to the ~200 line budget the plan
 * sets as the deciding threshold — see CHANGELOG.md for the full rationale.
 */

export type DiffLineType = 'add' | 'del' | 'context'

export interface DiffLine {
  type: DiffLineType
  content: string
  /** Present for 'add' and 'context' lines (side: RIGHT). Absent for 'del'. */
  newLineNumber?: number
  /** Present for 'del' and 'context' lines (side: LEFT). Absent for 'add'. */
  oldLineNumber?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface DiffFile {
  path: string
  oldPath: string | null
  status: DiffFileStatus
  binary: boolean
  hunks: DiffHunk[]
}

/** A file GitHub could not/would not provide reviewable content for. */
export interface SkippedFile {
  path: string
  reason: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Strips exactly one leading `a/` or `b/` (git's diff path prefixes). */
function stripAbPrefix (path: string): string {
  return path.replace(/^[ab]\//, '')
}

/**
 * Splits `diff --git a/X b/Y` into `[X, Y]`. Paths may themselves contain the
 * literal substring `b/` (T2.22), so a naive `split(' b/')` is ambiguous.
 * For the common (non-rename, non-space) case X === Y, so we search every
 * occurrence of the separator ` b/` for the split point that makes both
 * halves equal; if none does (e.g. an actual rename with a `diff --git`
 * line, which real callers never rely on for paths since `rename from/to`
 * lines are authoritative) we fall back to the first ` b/` occurrence.
 */
function splitGitHeaderPaths (rest: string): [string, string] {
  const prefixed = rest.startsWith('a/') ? rest.slice(2) : rest
  let searchFrom = 0
  for (;;) {
    const idx = prefixed.indexOf(' b/', searchFrom)
    if (idx === -1) break
    const left = prefixed.slice(0, idx)
    const right = prefixed.slice(idx + 3)
    if (left === right) return [left, right]
    searchFrom = idx + 1
  }
  const idx = prefixed.indexOf(' b/')
  if (idx === -1) return [prefixed, prefixed]
  return [prefixed.slice(0, idx), prefixed.slice(idx + 3)]
}

/** Parses the hunk-body lines of a single hunk (state: inside `@@ ... @@`). */
function parseHunkLines (bodyLines: string[], oldStart: number, newStart: number): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = oldStart
  let newLine = newStart
  for (const raw of bodyLines) {
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    const marker = raw.length === 0 ? ' ' : raw[0]
    const content = raw.length === 0 ? '' : raw.slice(1)
    if (marker === '+') {
      lines.push({ type: 'add', content, newLineNumber: newLine })
      newLine++
    } else if (marker === '-') {
      lines.push({ type: 'del', content, oldLineNumber: oldLine })
      oldLine++
    } else {
      lines.push({ type: 'context', content, newLineNumber: newLine, oldLineNumber: oldLine })
      newLine++
      oldLine++
    }
  }
  return lines
}

/** Parses a `pulls.listFiles` `file.patch` string (no file-level headers, just hunks). */
export function parseHunks (patchText: string): DiffHunk[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const hunks: DiffHunk[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const match = HUNK_HEADER.exec(line)
    if (!match) {
      i++
      continue
    }
    const oldStart = Number(match[1])
    const oldLines = match[2] !== undefined ? Number(match[2]) : 1
    const newStart = Number(match[3])
    const newLines = match[4] !== undefined ? Number(match[4]) : 1
    i++
    const body: string[] = []
    while (i < lines.length && !HUNK_HEADER.test(lines[i] ?? '')) {
      body.push(lines[i] ?? '')
      i++
    }
    // A trailing empty string from the final split() is not a real content line.
    if (body.length > 0 && i === lines.length && body[body.length - 1] === '') body.pop()
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: parseHunkLines(body, oldStart, newStart)
    })
  }
  return hunks
}

function parseFileBlock (blockLines: string[]): DiffFile | null {
  let renameFrom: string | null = null
  let renameTo: string | null = null
  let minusPath: string | null = null
  let plusPath: string | null = null
  let binary = false
  let binaryOld: string | null = null
  let binaryNew: string | null = null
  let gitHeaderOld: string | null = null
  let gitHeaderNew: string | null = null

  let i = 0
  const first = blockLines[0] ?? ''
  const gitHeaderMatch = /^diff --git (.+)$/.exec(first)
  if (gitHeaderMatch) {
    const [a, b] = splitGitHeaderPaths(gitHeaderMatch[1] ?? '')
    gitHeaderOld = a
    gitHeaderNew = b
    i = 1
  }

  // Header section: everything up to (but not including) the first hunk line.
  while (i < blockLines.length && !HUNK_HEADER.test(blockLines[i] ?? '')) {
    const line = blockLines[i] ?? ''
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length)
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4)
      minusPath = p === '/dev/null' ? null : stripAbPrefix(p)
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      plusPath = p === '/dev/null' ? null : stripAbPrefix(p)
    } else if (line.startsWith('Binary files ')) {
      binary = true
      const m = /^Binary files (.+) and (.+) differ$/.exec(line)
      if (m) {
        const bOld = m[1] ?? ''
        const bNew = m[2] ?? ''
        binaryOld = bOld === '/dev/null' ? null : stripAbPrefix(bOld)
        binaryNew = bNew === '/dev/null' ? null : stripAbPrefix(bNew)
      }
    }
    i++
  }

  // Hunk section: everything from the first hunk header onward, reused via
  // the same logic `parseHunks` uses for standalone `pulls.listFiles` patches.
  const hunks = parseHunks(blockLines.slice(i).join('\n'))

  let status: DiffFileStatus
  let path: string
  let oldPath: string | null = null

  if (renameFrom !== null && renameTo !== null) {
    status = 'renamed'
    path = renameTo
    oldPath = renameFrom
  } else if (binary) {
    const oldP = minusPath ?? binaryOld
    const newP = plusPath ?? binaryNew
    if (oldP === null && newP !== null) status = 'added'
    else if (newP === null && oldP !== null) status = 'deleted'
    else status = 'modified'
    path = newP ?? oldP ?? gitHeaderNew ?? gitHeaderOld ?? ''
  } else if (minusPath === null && plusPath !== null) {
    status = 'added'
    path = plusPath
  } else if (plusPath === null && minusPath !== null) {
    status = 'deleted'
    path = minusPath
  } else if (plusPath !== null) {
    status = 'modified'
    path = plusPath
  } else if (gitHeaderNew !== null) {
    // Mode-only change: no --- /+++ lines at all.
    status = 'modified'
    path = gitHeaderNew
  } else {
    // Nothing usable in this block (shouldn't happen for real GitHub diffs).
    return null
  }

  return { path, oldPath, status, binary, hunks }
}

/** Parses a full unified diff (GitHub's `mediaType: {format: 'diff'}` output). */
export function parseDiff (diffText: string): DiffFile[] {
  if (diffText.trim() === '') return []
  const normalized = diffText.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line]
      blocks.push(current)
    } else if (current) {
      current.push(line)
    }
  }

  const files: DiffFile[] = []
  for (const block of blocks) {
    const file = parseFileBlock(block)
    if (file) files.push(file)
  }
  return files
}
