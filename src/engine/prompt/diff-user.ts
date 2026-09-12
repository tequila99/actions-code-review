/**
 * DiffEngine user message (FR-30/FR-35/FR-36, SEC-1/SEC-2). Two independent
 * pieces, deliberately kept apart for testability:
 *
 * - `buildDiffUserPrompt` — pure, synchronous string builder. Takes
 *   already-loaded context text so it never touches the filesystem itself.
 * - `loadContextText` — the one async, filesystem-touching piece
 *   (`context.always`/`context.layers`, FR-36). Plain `fs.readFile` from
 *   `GITHUB_WORKSPACE`/`process.cwd()` for this stage (a full sandboxed
 *   `RepoAccess`, per PRD §7.2, is stage 7's `engine/tools/sandbox.ts`); the
 *   real reader is injectable (`readFile` param) so tests never touch disk.
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import path from 'node:path'
import { matchContextLayers, matchPathInstructions } from '../../config/globs.ts'
import type { ContextLayer, PathInstruction } from '../../config/schema.ts'
import { renderFile } from '../../github/diff-render.ts'
import type { DiffFile } from '../../github/diff-parse.ts'

export const UNTRUSTED_OPEN = '<untrusted_content>'
export const UNTRUSTED_CLOSE = '</untrusted_content>'

// ---------------------------------------------------------------------------
// SEC-2: sanitize prompt-injection-shaped sequences out of untrusted PR text
// before it is wrapped. This runs on PR title/description/file paths — the
// one piece of untrusted content the model author does not fully control the
// shape of by construction (a diff hunk can never syntactically contain a
// real `</untrusted_content>` close tag *and* still be valid diff content the
// same way free-form PR text can).
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: RegExp[] = [
  /<\/?\s*untrusted_content\s*>/gi,
  /<\/?\s*system\s*>/gi,
  /\[\/?\s*inst\s*\]/gi,
  /^\s*system\s*:/gim
]

/** SEC-2: strips/neutralizes sequences that imitate prompt markup (T4.18/T4.19). */
export function sanitizeUntrustedText (text: string): string {
  let result = text
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(pattern, '[sanitized]')
  }
  return result
}

function wrapUntrusted (label: string, content: string): string {
  return `${label}:\n${UNTRUSTED_OPEN}\n${content}\n${UNTRUSTED_CLOSE}`
}

/**
 * Returns every `path_instructions` entry matched by at least one of `files`
 * (FR-35), deduplicated by identity, in first-matched order. Instructions
 * that match none of `files` are never returned (T4.14 — no point spending
 * tokens on instructions irrelevant to this batch).
 */
function collectMatchedPathInstructions (
  files: readonly DiffFile[],
  pathInstructions: readonly PathInstruction[]
): PathInstruction[] {
  const seen = new Set<PathInstruction>()
  const result: PathInstruction[] = []
  for (const file of files) {
    for (const instruction of matchPathInstructions(file.path, pathInstructions)) {
      if (!seen.has(instruction)) {
        seen.add(instruction)
        result.push(instruction)
      }
    }
  }
  return result
}

export interface DiffUserPromptContext {
  text: string
  truncated: boolean
}

export interface DiffUserPromptParams {
  /** This batch's files (already selected/budgeted by the caller). */
  files: readonly DiffFile[]
  contextLines: number
  prTitle: string
  prBody: string
  /** Full config list — matched per-file internally (FR-35, T4.13/T4.14). */
  pathInstructions: readonly PathInstruction[]
  /** Pre-loaded via `loadContextText` (FR-36). Pass `{ text: '', truncated: false }` when there is none. */
  context: DiffUserPromptContext
}

/** FR-30/FR-35/FR-36, SEC-1: builds the user message for one DiffEngine batch. */
export function buildDiffUserPrompt (params: DiffUserPromptParams): string {
  const sections: string[] = []

  const title = sanitizeUntrustedText(params.prTitle)
  const body = sanitizeUntrustedText(
    params.prBody.trim() !== '' ? params.prBody : '(no description provided)'
  )
  sections.push(wrapUntrusted('Pull request title', title))
  sections.push(wrapUntrusted('Pull request description', body))

  const matchedInstructions = collectMatchedPathInstructions(params.files, params.pathInstructions)
  if (matchedInstructions.length > 0) {
    sections.push(
      `Path-specific instructions (apply only to the listed path):\n${matchedInstructions
        .map((instruction) => `- ${instruction.path}: ${instruction.instructions}`)
        .join('\n')}`
    )
  }

  if (params.context.text.trim() !== '') {
    const truncationNote = params.context.truncated
      ? ' (truncated to fit context.max_context_bytes)'
      : ''
    sections.push(
      `Repository context files${truncationNote}:\n${wrapUntrusted('Context', params.context.text)}`
    )
  }

  for (const file of params.files) {
    const renameNote = file.oldPath ? ` (renamed from ${sanitizeUntrustedText(file.oldPath)})` : ''
    const rendered = renderFile(file, params.contextLines)
    sections.push(
      `File: ${sanitizeUntrustedText(file.path)}${renameNote}\n${wrapUntrusted('Diff', rendered)}`
    )
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// FR-36: loading context.always / context.layers content.
// ---------------------------------------------------------------------------

export interface LoadContextParams {
  /** Files used to decide which `context.layers` entries match (FR-36). */
  files: readonly DiffFile[]
  always: readonly string[]
  layers: readonly ContextLayer[]
  maxContextBytes: number
  /** Defaults to `GITHUB_WORKSPACE` env var, then `process.cwd()`. */
  workspaceRoot?: string
  /** Injectable for tests; defaults to real `fs.readFile(path, 'utf8')`. */
  readFile?: (absolutePath: string) => Promise<string>
}

function truncateToByteBudget (text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let result = text
  while (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1)
  }
  return result
}

/**
 * FR-36: loads `context.always` (unconditional) and every `context.layers`
 * entry matching at least one of `files`, deduplicated, in declaration
 * order. Missing files are skipped silently (best-effort context, not a hard
 * requirement). Truncates to `maxContextBytes` total with an explicit
 * `truncated: true` flag when the budget is exceeded (T4.16).
 */
export async function loadContextText (params: LoadContextParams): Promise<DiffUserPromptContext> {
  const relPaths: string[] = []
  const seen = new Set<string>()
  for (const relPath of params.always) {
    if (!seen.has(relPath)) {
      seen.add(relPath)
      relPaths.push(relPath)
    }
  }
  for (const file of params.files) {
    for (const relPath of matchContextLayers(file.path, params.layers)) {
      if (!seen.has(relPath)) {
        seen.add(relPath)
        relPaths.push(relPath)
      }
    }
  }

  if (relPaths.length === 0) return { text: '', truncated: false }

  const root = params.workspaceRoot ?? process.env.GITHUB_WORKSPACE ?? process.cwd()
  const reader = params.readFile ?? ((absolutePath: string) => fsReadFile(absolutePath, 'utf8'))

  const parts: string[] = []
  let usedBytes = 0
  let truncated = false

  for (const relPath of relPaths) {
    if (usedBytes >= params.maxContextBytes) {
      truncated = true
      break
    }

    let content: string
    try {
      content = await reader(path.join(root, relPath))
    } catch {
      continue // best-effort: an unreadable/missing context file is silently skipped
    }

    const chunk = `--- ${relPath} ---\n${content}\n`
    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    const remaining = params.maxContextBytes - usedBytes

    if (chunkBytes > remaining) {
      const clipped = truncateToByteBudget(chunk, remaining)
      parts.push(clipped)
      truncated = true
      break
    }

    parts.push(chunk)
    usedBytes += chunkBytes
  }

  return { text: parts.join('\n'), truncated }
}
