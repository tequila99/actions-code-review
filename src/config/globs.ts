import { minimatch } from 'minimatch'
import type { ContextLayer, PathInstruction } from './schema.ts'

const MINIMATCH_OPTIONS = { dot: true }

/** Strips a leading `./` (repeated) so `./src/a.ts` and `src/a.ts` compare equal. */
export function normalizePath (filePath: string): string {
  return filePath.replace(/^(\.\/)+/, '')
}

/**
 * `include`/`exclude` glob matching (FR-11): `exclude` always wins over
 * `include` — a file matching both is excluded. An empty `include` list
 * means "everything passes" (subject to `exclude`).
 */
export function isFileIncluded (
  filePath: string,
  include: readonly string[],
  exclude: readonly string[]
): boolean {
  const normalized = normalizePath(filePath)
  if (exclude.some((pattern) => minimatch(normalized, pattern, MINIMATCH_OPTIONS))) {
    return false
  }
  if (include.length === 0) return true
  return include.some((pattern) => minimatch(normalized, pattern, MINIMATCH_OPTIONS))
}

/**
 * Returns every `path_instructions` entry whose glob matches `filePath`
 * (FR-35), in declaration order — coderabbit-style "all matches apply", not
 * "first match wins".
 */
export function matchPathInstructions (
  filePath: string,
  instructions: readonly PathInstruction[]
): PathInstruction[] {
  const normalized = normalizePath(filePath)
  return instructions.filter((instruction) =>
    minimatch(normalized, instruction.path, MINIMATCH_OPTIONS)
  )
}

/**
 * Returns the deduplicated union of `context_files` from every
 * `context.layers` entry whose glob matches `filePath` (FR-36).
 */
export function matchContextLayers (filePath: string, layers: readonly ContextLayer[]): string[] {
  const normalized = normalizePath(filePath)
  const files: string[] = []
  for (const layer of layers) {
    if (!minimatch(normalized, layer.path, MINIMATCH_OPTIONS)) continue
    for (const file of layer.context_files) {
      if (!files.includes(file)) files.push(file)
    }
  }
  return files
}
