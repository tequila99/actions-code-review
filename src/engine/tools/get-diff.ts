/**
 * `get_diff` tool (FR-41). Renders from `ctx.target.files` — the same
 * already-fetched/selected `DiffFile[]` the rest of the review run uses, so
 * this never makes its own GitHub API call. Reuses `github/diff-render.ts`
 * (the exact renderer `DiffEngine` sends to the model) for consistent
 * line-numbered output.
 */

import { renderFile } from '../../github/diff-render.ts'
import { truncate } from './truncate.ts'
import type { ToolExecutionContext, ToolResult } from './registry.ts'
import type { ToolSpec } from '../../provider/types.ts'

export const GET_DIFF_SPEC: ToolSpec = {
  name: 'get_diff',
  description:
    'Get the pull request diff. With no argument, returns the diff for every changed file in scope; ' +
    'with `path`, returns only that file\'s diff.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional: restrict to a single file\'s diff.' }
    }
  }
}

export async function getDiff (args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  // Some models (e.g. the GPT-5.6 family via OpenRouter, confirmed on a real production trace)
  // send an empty string for an optional parameter they mean to omit, rather than leaving it out
  // — an empty path is never a meaningful "restrict to this file", so treat it the same as absent.
  const requestedPath = typeof a.path === 'string' && a.path !== '' ? a.path : undefined

  if (requestedPath === undefined) {
    if (ctx.target.files.length === 0) {
      return { content: '(no files in the review scope)', isError: false }
    }
    const rendered = ctx.target.files
      .map((file) => `--- ${file.path} ---\n${renderFile(file, ctx.contextLines)}`)
      .join('\n\n')
    return { content: truncate(rendered, ctx.toolOutputMaxBytes), isError: false }
  }

  const file = ctx.target.files.find((f) => f.path === requestedPath)
  if (file === undefined) {
    // A path that *is* in the PR but was dropped by `select-files.ts` needs its own answer. The
    // generic message below reads as "this file is not in the PR", which contradicts what the model
    // has already inferred from the rest of the diff — confirmed on a real production trace
    // (x-ai/grok-4.6), where that contradiction sent it back to re-ask for the same dropped path a
    // second time, several iterations later.
    const dropped = ctx.target.skipped.find((f) => f.path === requestedPath)
    if (dropped !== undefined) {
      return {
        content:
          `get_diff failed: ${requestedPath} is part of this pull request but was dropped from the ` +
          `review scope (${dropped.reason}), so its diff is not available. Its current contents are ` +
          'still in the checkout — use read_file if you need them.',
        isError: true
      }
    }
    return {
      content:
        `get_diff failed: ${requestedPath} is not one of the files in this pull request's diff. ` +
        'See the list of files given at the start of this review; call get_diff with no argument ' +
        'to see them all.',
      isError: true
    }
  }
  return { content: truncate(renderFile(file, ctx.contextLines), ctx.toolOutputMaxBytes), isError: false }
}
