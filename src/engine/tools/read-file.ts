/**
 * `read_file` tool (FR-42). Returns file content with 1-based line numbers
 * (so the model can cite exact lines back in `post_comment`), sandboxed via
 * `sandbox.ts`. Every failure mode is a `{isError: true}` result, never a
 * thrown exception (T7.16) — the tool-loop keeps running either way.
 */

import { readFile as fsReadFile, stat } from 'node:fs/promises'
import { resolveSandboxPath } from './sandbox.ts'
import { truncate } from './truncate.ts'
import type { ToolExecutionContext, ToolResult } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'

export const READ_FILE_SPEC: ToolSpec = {
  name: 'read_file',
  description:
    'Read a file from the pull request repository checkout. Returns its content with 1-based ' +
    'line numbers. Optionally restrict to a line range with start_line/end_line (both inclusive). ' +
    'A file far larger than the tool output limit is refused unless start_line/end_line is given — ' +
    'request a specific range instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the repository root.' },
      start_line: { type: 'integer', description: 'First line to return (1-based, inclusive).' },
      end_line: { type: 'integer', description: 'Last line to return (1-based, inclusive).' }
    },
    required: ['path']
  }
}

/** TZ6: a file this many times over `tool_output_max_bytes`, read with no `start_line`/`end_line`,
 * is refused rather than read whole and truncated after the fact — reading a multi-MB file into
 * memory just to throw most of it away at the `truncate()` step wastes the read for no benefit the
 * model can use (it never sees past the cutoff anyway). Checked from `stat()` before the read, so
 * the file is never even opened in this case. */
const STAT_REFUSAL_MULTIPLIER = 4

/** A conservative binary check: a NUL byte anywhere in the first 8000 bytes
 * (same heuristic `git`/most diff tools use) means "don't try to decode
 * this as text". */
function looksBinary (buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  return sample.includes(0)
}

function numberLines (content: string, startLine?: number, endLine?: number): string {
  const lines = content.split('\n')
  const from = startLine !== undefined ? Math.max(1, startLine) : 1
  const to = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length
  const out: string[] = []
  for (let i = from; i <= to; i++) {
    out.push(`${i}: ${lines[i - 1] ?? ''}`)
  }
  return out.join('\n')
}

export async function readFile (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  const startLine = typeof a.start_line === 'number' ? a.start_line : undefined
  const endLine = typeof a.end_line === 'number' ? a.end_line : undefined

  const resolved = await resolveSandboxPath(a.path, ctx.workspaceRoot)
  if (!resolved.ok) {
    return { content: `read_file failed: ${resolved.reason}`, isError: true }
  }

  let fileStat
  try {
    fileStat = await stat(resolved.absolutePath)
  } catch {
    return { content: `read_file failed: file not found: ${String(a.path)}`, isError: true }
  }
  if (!fileStat.isFile()) {
    return { content: `read_file failed: not a regular file: ${String(a.path)}`, isError: true }
  }

  const hasRange = startLine !== undefined || endLine !== undefined
  if (!hasRange && fileStat.size > ctx.toolOutputMaxBytes * STAT_REFUSAL_MULTIPLIER) {
    return {
      content:
        `read_file failed: ${String(a.path)} is ${fileStat.size} bytes, too large to read in full — ` +
        'call again with start_line/end_line to request a specific range.',
      isError: true
    }
  }

  const buffer = await fsReadFile(resolved.absolutePath)
  if (looksBinary(buffer)) {
    return {
      content: `read_file failed: ${String(a.path)} looks like a binary file, not readable as text`,
      isError: true
    }
  }

  const numbered = numberLines(buffer.toString('utf8'), startLine, endLine)
  return { content: truncate(numbered, ctx.toolOutputMaxBytes), isError: false }
}
