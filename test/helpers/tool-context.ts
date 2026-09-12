import type { ToolExecutionContext } from '../../src/engine/tools/registry.ts'
import { createCommentAccumulator } from '../../src/engine/tools/post-comment.ts'
import { createWebSearchCallBudget } from '../../src/engine/tools/web-search.ts'

/**
 * Minimal, overridable `ToolExecutionContext` for `engine/tools/**` tests —
 * every tool handler takes this as its second argument. `comments` defaults
 * to a fresh accumulator with a generous cap so tests that don't care about
 * `post_comment`'s own limit don't have to think about it. `webSearch`
 * defaults to a fresh 4-call budget against a real OpenRouter host, so
 * `web-search.test.ts` only has to override what a given case actually
 * varies (e.g. `baseUrl` for the non-OpenRouter-host case).
 */
export function makeToolContext (
  workspaceRoot: string,
  overrides: Partial<Omit<ToolExecutionContext, 'workspaceRoot'>> = {}
): ToolExecutionContext {
  return {
    workspaceRoot,
    toolOutputMaxBytes: 32768,
    contextLines: 3,
    target: { files: [], skipped: [] },
    comments: createCommentAccumulator(999),
    allowSuggestions: true,
    webSearch: {
      apiKey: 'sk-test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      maxCalls: 4,
      extraHeaders: {},
      budget: createWebSearchCallBudget(4)
    },
    runSignal: new AbortController().signal,
    ...overrides
  }
}
