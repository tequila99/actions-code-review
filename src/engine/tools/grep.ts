/**
 * `grep` tool (FR-44). A regex engine has no way to be interrupted
 * mid-match once a synchronous `RegExp.exec` starts catastrophically
 * backtracking (Node's regex engine is not preemptible from JS), so T7.23's
 * ReDoS protection is a static rejection of known-catastrophic patterns
 * (nested/overlapping quantifiers) *before* ever running the regex, backed
 * up by a coarse wall-clock deadline across the overall file walk as a
 * second line of defense (R-3).
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { matchesGlob } from './glob-match.ts'
import { walkWorkspace } from './walk.ts'
import { truncate } from './truncate.ts'
import type { ToolExecutionContext, ToolResult } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'

export const GREP_SPEC: ToolSpec = {
  name: 'grep',
  description:
    'Search file contents in the repository checkout for a regular expression pattern. ' +
    'An optional glob with no "/" in it matches file names at any depth, so "*.ts" searches ' +
    'every TypeScript file in the repository, not just those at its root.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      glob: { type: 'string', description: 'Optional glob to restrict which files are searched.' }
    },
    required: ['pattern']
  }
}

const MAX_MATCHES = 200
const MAX_PATTERN_LENGTH = 500
const TIME_BUDGET_MS = 3000

/** Known-catastrophic constructs: a quantified group itself quantified
 * again (`(x+)+`, `(x*)*`, `(x+)*`, `(x*)+`, and the `{n,}` form). This is a
 * heuristic, not a proof of safety — it catches the classic cases without
 * needing a full NFA analysis. */
const REDOS_HEURISTICS: readonly RegExp[] = [
  /\([^()]*[+*]\)[+*]/,
  /\([^()]*[+*]\)\{\d*,/
]

function looksCatastrophic (pattern: string): boolean {
  return REDOS_HEURISTICS.some((h) => h.test(pattern))
}

function looksBinary (buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

export async function grep (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  const pattern = typeof a.pattern === 'string' ? a.pattern : ''
  if (pattern === '') {
    return { content: 'grep failed: pattern must be a non-empty string', isError: true }
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { content: 'grep failed: pattern is too long', isError: true }
  }
  if (looksCatastrophic(pattern)) {
    return {
      content: 'grep failed: pattern rejected — looks like it could cause catastrophic backtracking',
      isError: true
    }
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (err) {
    return { content: `grep failed: invalid pattern — ${String(err)}`, isError: true }
  }

  // Same empty-string-for-omitted-optional-parameter quirk as get-diff.ts's `path` — an empty
  // glob is never a meaningful "match nothing", so treat it the same as absent.
  const glob = typeof a.glob === 'string' && a.glob !== '' ? a.glob : undefined
  const root = path.resolve(ctx.workspaceRoot)
  const allFiles: string[] = []
  await walkWorkspace(root, root, allFiles)
  const files = glob !== undefined ? allFiles.filter((f) => matchesGlob(f, glob)) : allFiles

  const matches: string[] = []
  const deadline = Date.now() + TIME_BUDGET_MS
  let timedOut = false

  for (const rel of files.sort()) {
    if (Date.now() > deadline) {
      timedOut = true
      break
    }
    if (matches.length >= MAX_MATCHES) break

    let buffer: Buffer
    try {
      buffer = await readFile(path.join(root, rel))
    } catch {
      continue
    }
    if (looksBinary(buffer)) continue

    const lines = buffer.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) break
      if (regex.test(lines[i]!)) {
        matches.push(`${rel}:${i + 1}:${lines[i]}`)
      }
    }
  }

  if (matches.length === 0 && !timedOut) {
    return { content: '(no matches)', isError: false }
  }

  const suffixParts: string[] = []
  if (matches.length >= MAX_MATCHES) suffixParts.push(`truncated to ${MAX_MATCHES} matches`)
  if (timedOut) suffixParts.push('search stopped early: time budget exceeded')
  const suffix = suffixParts.length > 0 ? `\n… (${suffixParts.join('; ')})` : ''

  return { content: truncate(matches.join('\n') + suffix, ctx.toolOutputMaxBytes), isError: false }
}
