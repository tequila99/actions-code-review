import { isFileIncluded } from '../config/globs.ts'
import type { DiffFile, SkippedFile } from './diff-parse.ts'
import type { PathInstruction } from '../config/schema.ts'
import { matchPathInstructions } from '../config/globs.ts'

export interface SelectFilesParams {
  files: readonly DiffFile[]
  include: readonly string[]
  exclude: readonly string[]
  maxFiles: number
  maxDiffBytes: number
  pathInstructions: readonly PathInstruction[]
}

export interface SelectFilesResult {
  files: DiffFile[]
  skipped: SkippedFile[]
  truncated: boolean
  /** Set when every candidate file was filtered out before any limit applied (T2.50). */
  skippedReason?: 'no_changes'
}

/** Rough byte size of a file's patch content, used for `max_diff_bytes` accounting. */
function diffFileByteSize (file: DiffFile): number {
  let size = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      size += line.content.length + 1
    }
  }
  return size
}

function isPureDeletion (file: DiffFile): boolean {
  let hasDel = false
  let hasAdd = false
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'del') hasDel = true
      if (line.type === 'add') hasAdd = true
    }
  }
  return hasDel && !hasAdd
}

function extensionOf (path: string): string {
  const base = path.split('/').pop() ?? path
  const dotIndex = base.lastIndexOf('.')
  return dotIndex <= 0 ? '' : base.slice(dotIndex + 1)
}

/**
 * PRD §7.4 rule 2: the repo's "main language" is determined locally (no
 * `repos.listLanguages` API call) as the extension with the most changed
 * files; ties broken by the extension with the larger total patch size.
 */
function detectMainExtension (files: readonly DiffFile[]): string | null {
  const counts = new Map<string, number>()
  const bytes = new Map<string, number>()
  for (const file of files) {
    const ext = extensionOf(file.path)
    if (ext === '') continue
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
    bytes.set(ext, (bytes.get(ext) ?? 0) + diffFileByteSize(file))
  }
  let best: string | null = null
  for (const [ext, count] of counts) {
    if (best === null) {
      best = ext
      continue
    }
    const bestCount = counts.get(best) ?? 0
    if (
      count > bestCount ||
      (count === bestCount && (bytes.get(ext) ?? 0) > (bytes.get(best) ?? 0))
    ) {
      best = ext
    }
  }
  return best
}

/**
 * Filters, prioritizes and truncates the PR's diff files (FR-11/FR-12/FR-13,
 * PRD §7.4). Binary files and files excluded by `include`/`exclude` are
 * dropped silently — they were deliberately excluded, not "left unreviewed"
 * (T2.49), so they never appear in `skipped` and never count against
 * `maxFiles`/`maxDiffBytes`.
 *
 * Priority order among the remaining files (most important first):
 * 1. Files matched by `pathInstructions`.
 * 2. Files on the repo's main language (by extension, §7.4 rule 2).
 * 3. Pure-deletion patches sort after everything else (§7.4 rule 4).
 * 4. Ascending patch byte size (§7.4 rule 3) — used both as the final
 *    ordering tiebreaker and, for same-priority files, the natural
 *    "small files first" order.
 */
export function selectFiles (params: SelectFilesParams): SelectFilesResult {
  const candidates = params.files.filter(
    (f) => !f.binary && isFileIncluded(f.path, params.include, params.exclude)
  )

  if (candidates.length === 0) {
    return { files: [], skipped: [], truncated: false, skippedReason: 'no_changes' }
  }

  const mainExtension = detectMainExtension(candidates)

  const withKeys = candidates.map((file, index) => {
    const pInstrRank = matchPathInstructions(file.path, params.pathInstructions).length > 0 ? 0 : 1
    const mainLangRank = mainExtension !== null && extensionOf(file.path) === mainExtension ? 0 : 1
    const pureDeletionRank = isPureDeletion(file) ? 1 : 0
    const size = diffFileByteSize(file)
    return { file, index, pInstrRank, mainLangRank, pureDeletionRank, size }
  })

  withKeys.sort((a, b) => {
    if (a.pInstrRank !== b.pInstrRank) return a.pInstrRank - b.pInstrRank
    if (a.mainLangRank !== b.mainLangRank) return a.mainLangRank - b.mainLangRank
    if (a.pureDeletionRank !== b.pureDeletionRank) return a.pureDeletionRank - b.pureDeletionRank
    if (a.size !== b.size) return a.size - b.size
    return a.index - b.index // stable tiebreak
  })

  const selected: DiffFile[] = []
  const skipped: SkippedFile[] = []
  let cumulativeBytes = 0
  let limitReason: 'max_files' | 'max_diff_bytes' | null = null

  for (const entry of withKeys) {
    if (limitReason !== null) {
      skipped.push({ path: entry.file.path, reason: limitReason })
      continue
    }
    if (selected.length >= params.maxFiles) {
      limitReason = 'max_files'
      skipped.push({ path: entry.file.path, reason: limitReason })
      continue
    }
    if (cumulativeBytes + entry.size > params.maxDiffBytes) {
      limitReason = 'max_diff_bytes'
      skipped.push({ path: entry.file.path, reason: limitReason })
      continue
    }
    selected.push(entry.file)
    cumulativeBytes += entry.size
  }

  return { files: selected, skipped, truncated: skipped.length > 0 }
}
