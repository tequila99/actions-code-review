/**
 * `list_files` tool (FR-43). Walks the sandboxed workspace tree itself
 * (rather than `fs.readdir(..., {recursive: true})`, whose `Dirent.path`/
 * `parentPath` shape has shifted across recent Node versions) so every
 * directory it descends into is re-validated by `sandbox.ts` first — a
 * denied directory (`.git`, ...) is never even walked, not just filtered
 * out afterwards.
 */

import path from 'node:path'
import { matchesGlob } from './glob-match.ts'
import { walkWorkspace } from './walk.ts'
import { truncate } from './truncate.ts'
import type { ToolExecutionContext, ToolResult } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'

export const LIST_FILES_SPEC: ToolSpec = {
  name: 'list_files',
  description:
    'List files in the repository checkout matching a glob pattern (e.g. "src/**/*.ts"). ' +
    'A pattern with no "/" in it matches file names at any depth, so "*.ts" finds every ' +
    'TypeScript file in the repository, not just those at its root.',
  parameters: {
    type: 'object',
    properties: {
      glob: { type: 'string', description: 'Glob pattern, relative to the repository root.' }
    },
    required: ['glob']
  }
}

const MAX_RESULTS = 500

export async function listFiles (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.glob !== 'string' || a.glob.trim() === '') {
    return { content: 'list_files failed: glob must be a non-empty string', isError: true }
  }

  const root = path.resolve(ctx.workspaceRoot)
  const all: string[] = []
  await walkWorkspace(root, root, all)

  const matches = all.filter((rel) => matchesGlob(rel, a.glob as string)).sort()
  if (matches.length === 0) {
    return { content: '(no files matched)', isError: false }
  }

  const limited = matches.slice(0, MAX_RESULTS)
  const suffix =
    matches.length > MAX_RESULTS
      ? `\n… (truncated to ${MAX_RESULTS} of ${matches.length} matches)`
      : ''
  return { content: truncate(limited.join('\n') + suffix, ctx.toolOutputMaxBytes), isError: false }
}
