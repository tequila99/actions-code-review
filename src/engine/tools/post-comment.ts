/**
 * `post_comment` tool (FR-45) and its backing accumulator. Comments are
 * never published as they arrive — they accumulate in memory for the whole
 * agent run, and `agent-engine.ts` hands the final list to the same
 * `report/**` publishing pipeline `DiffEngine` uses (`ReviewResult.findings`).
 * The `3 x max_comments` safety cap (FR-66) exists only to stop a runaway
 * tool-loop from accumulating without bound — final truncation to
 * `max_comments` itself still happens at the publish layer, by severity.
 *
 * FR-51: optionally accepts a literal `original_snippet`/`suggestion` pair.
 * Unlike `DiffEngine` (FR-69, permanently removed — truncated diff hunks
 * can't guarantee a syntactically correct literal replacement), `AgentEngine`
 * can `read_file` the whole file, so the handler re-reads lines `[line,
 * end_line ?? line]` from disk and only keeps `suggestion` when
 * `original_snippet` matches byte-for-byte — the verification this feature
 * lacked the first time it existed, before it was dropped entirely and
 * later reintroduced with this check.
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import type { Finding } from '../types.ts'
import type { ToolExecutionContext, ToolResult } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'
import { resolveSandboxPath } from './sandbox.ts'

const BASE_DESCRIPTION =
  'Record a review finding for a specific file/line. Comments are accumulated and published ' +
  'together at the end of the review — this does not post anything immediately.'

const SUGGESTION_DESCRIPTION =
  ' To attach a literal code-suggestion (GitHub\'s "Apply suggestion" button), provide BOTH ' +
  'original_snippet and suggestion — never just one. original_snippet must match the current ' +
  'file content of lines [line, end_line ?? line] exactly (re-read the file first if unsure); a ' +
  'mismatch drops the suggestion but still records the finding.'

/** `allowSuggestions` (`config.agent.allow_suggestions`, default `true`) controls whether
 * `original_snippet`/`suggestion` even appear as callable parameters — when `false` the model
 * never sees them, not merely a rejection at the handler layer (T7.4/TI.4). */
export function buildPostCommentSpec (allowSuggestions: boolean): ToolSpec {
  const properties: Record<string, unknown> = {
    path: { type: 'string', description: 'File path exactly as it appears in the diff.' },
    line: { type: 'integer', description: 'Line number in the new version of the file.' },
    end_line: { type: 'integer', description: 'Optional: last line of a multi-line range.' },
    severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
    category: {
      type: 'string',
      description: 'e.g. correctness, security, performance, style, architecture.'
    },
    message: { type: 'string' }
  }

  if (allowSuggestions) {
    properties.original_snippet = {
      type: 'string',
      description:
        'Literal text of lines [line, end_line ?? line] BEFORE your fix, exactly as it currently ' +
        'reads on disk. Provide together with suggestion, or omit both.'
    }
    properties.suggestion = {
      type: 'string',
      description: 'Literal replacement text for those same lines, AFTER your fix.'
    }
  }

  return {
    name: 'post_comment',
    description: allowSuggestions ? BASE_DESCRIPTION + SUGGESTION_DESCRIPTION : BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties,
      required: ['path', 'line', 'severity', 'category', 'message']
    }
  }
}

const VALID_SEVERITIES = new Set(['high', 'medium', 'low', 'info'])

export interface CommentEntry {
  path: string
  line: number
  endLine?: number
  severity: Finding['severity']
  category: string
  message: string
  /** Already verified against disk by `postComment` before reaching the accumulator — this
   * layer just stores whatever it's given. */
  suggestion?: string
}

export type AddResult =
  | { added: true }
  | { added: false, reason: 'duplicate' | 'limit_reached' }

export interface CommentAccumulator {
  add(entry: CommentEntry): AddResult
  readonly findings: readonly Finding[]
}

class Accumulator implements CommentAccumulator {
  private readonly cap: number
  private readonly seen = new Set<string>()
  private readonly accepted: Finding[] = []

  constructor (cap: number) {
    this.cap = cap
  }

  get findings (): readonly Finding[] {
    return this.accepted
  }

  add (entry: CommentEntry): AddResult {
    const key = `${entry.path}:${entry.line}`
    if (this.seen.has(key)) return { added: false, reason: 'duplicate' }
    if (this.accepted.length >= this.cap) return { added: false, reason: 'limit_reached' }
    this.seen.add(key)
    this.accepted.push({
      path: entry.path,
      line: entry.line,
      ...(entry.endLine !== undefined ? { endLine: entry.endLine } : {}),
      severity: entry.severity,
      category: entry.category,
      message: entry.message,
      ...(entry.suggestion !== undefined ? { suggestion: entry.suggestion } : {})
    })
    return { added: true }
  }
}

/** `cap` is the `3 x max_comments` protective ceiling (FR-66), not
 * `max_comments` itself — final severity-based truncation happens later, at
 * publish time. */
export function createCommentAccumulator (cap: number): CommentAccumulator {
  return new Accumulator(cap)
}

function validationErrors (a: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (typeof a.path !== 'string' || a.path.trim() === '') errors.push('path must be a non-empty string')
  if (typeof a.line !== 'number' || !Number.isInteger(a.line) || a.line < 1) {
    errors.push('line must be a positive integer')
  }
  if (typeof a.severity !== 'string' || !VALID_SEVERITIES.has(a.severity)) {
    errors.push('severity must be one of high|medium|low|info')
  }
  if (typeof a.category !== 'string' || a.category.trim() === '') {
    errors.push('category must be a non-empty string')
  }
  if (typeof a.message !== 'string' || a.message.trim() === '') {
    errors.push('message must be a non-empty string')
  }
  return errors
}

/** Reads lines `[line, endLine ?? line]` (1-based, inclusive) of `path` from disk, joined with
 * `'\n'`, no trailing newline — the exact shape a model would need to reproduce as
 * `original_snippet`. `null` on any failure (sandbox rejection, missing file, out-of-range
 * lines) — the caller treats that identically to a mismatch. */
async function readSnippet (
  ctx: ToolExecutionContext,
  path: string,
  line: number,
  endLine: number | undefined
): Promise<string | null> {
  const resolved = await resolveSandboxPath(path, ctx.workspaceRoot)
  if (!resolved.ok) return null
  let buffer: Buffer
  try {
    buffer = await fsReadFile(resolved.absolutePath)
  } catch {
    return null
  }
  const lines = buffer.toString('utf8').split('\n')
  const from = line
  const to = endLine ?? line
  if (from < 1 || to > lines.length || from > to) return null
  return lines.slice(from - 1, to).join('\n')
}

export async function postComment (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  const errors = validationErrors(a)
  if (errors.length > 0) {
    return { content: `post_comment failed: ${errors.join('; ')}`, isError: true }
  }

  const endLine = typeof a.end_line === 'number' ? a.end_line : undefined
  const hasOriginalSnippet = typeof a.original_snippet === 'string'
  const hasSuggestion = typeof a.suggestion === 'string'

  let suggestion: string | undefined
  let suggestionError: string | undefined
  if (hasOriginalSnippet !== hasSuggestion) {
    suggestionError =
      'post_comment: original_snippet and suggestion must both be provided together, or neither ' +
      '— the finding was recorded without a suggestion.'
  } else if (hasOriginalSnippet && hasSuggestion) {
    const actual = await readSnippet(ctx, a.path as string, a.line as number, endLine)
    if (actual !== null && actual === a.original_snippet) {
      suggestion = a.suggestion as string
    } else {
      suggestionError =
        'post_comment: original_snippet did not match the file on disk — re-read the file and ' +
        'try again. The finding was recorded without a suggestion.'
    }
  }

  const result = ctx.comments.add({
    path: a.path as string,
    line: a.line as number,
    ...(endLine !== undefined ? { endLine } : {}),
    severity: a.severity as Finding['severity'],
    category: a.category as string,
    message: a.message as string,
    ...(suggestion !== undefined ? { suggestion } : {})
  })

  if (!result.added && result.reason === 'duplicate') {
    return {
      content: `post_comment: duplicate comment for ${String(a.path)}:${String(a.line)}, ignored`,
      isError: false
    }
  }
  if (!result.added) {
    return {
      content: 'post_comment failed: comment limit reached for this run',
      isError: true
    }
  }
  if (suggestionError !== undefined) {
    return { content: suggestionError, isError: true }
  }
  return { content: 'post_comment: accepted', isError: false }
}
