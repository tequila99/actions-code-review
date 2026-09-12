import type { TestContext } from 'node:test'
import { createFakeProvider, makeCompletionResponse } from '../helpers/fake-provider.ts'
import type { CompletionRequest, CompletionResponse } from '../../src/provider/types.ts'
import { selectEngine } from '../../src/engine/selector.ts'
import type { ResolvedConfig } from '../../src/config/schema.ts'
import type { GithubContext } from '../../src/github/context.ts'
import type { PrPhaseResult, DiffPhaseResult, EnginePhaseResult } from '../../src/main.ts'
import type { ReviewContext } from '../../src/engine/types.ts'

/**
 * Stage 6 e2e tests (T6.10-T6.17): full `run()` with `internals.loadConfig`/
 * `createContext` mocked (test-controlled config + a mocked Octokit client,
 * same DI seam `main.test.ts` already uses) but `internals.fetchPr`/
 * `fetchDiff` left as the *real*, now-wired implementations — they run
 * against the mocked Octokit client exactly like they would against the
 * real one. Only the network-calling provider is faked: `internals.runEngine`
 * is overridden to run the real `selectEngine()` + `DiffEngine` with a fake
 * `ProviderAdapter` instead of `provider/factory.ts`'s real
 * (fetch-calling) one.
 */

/** Captures `core.setFailed`/`core.setOutput`'s underlying `process.stdout.write` calls. */
export function captureStdoutWrites (t: TestContext): string[] {
  const writes: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

/** Parses `::set-output name=<key>::<value>` commands out of captured stdout writes. */
export function parseSetOutputCommands (writes: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /^::set-output name=([^:]+)::(.*)$/
  for (const write of writes) {
    for (const line of write.split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (match) result[match[1]!] = match[2]!
    }
  }
  return result
}

/**
 * Builds a synthetic unified diff (GitHub `mediaType: {format: 'diff'}`
 * text) with one 3-line hunk per path: an unchanged line, a changed line
 * (new-version line 2, a valid inline-comment anchor), and another
 * unchanged line.
 */
export function buildDiffText (paths: readonly string[]): string {
  return paths
    .map(
      (p) =>
        `diff --git a/${p} b/${p}\n` +
        `--- a/${p}\n` +
        `+++ b/${p}\n` +
        '@@ -1,3 +1,3 @@\n' +
        ' line1\n' +
        '-line2 old\n' +
        '+line2 new\n' +
        ' line3'
    )
    .join('\n')
}

export interface PrMetadata {
  draft?: boolean
  labels?: string[]
  title?: string
  body?: string | null
  headSha?: string
}

export function prMetadataResponse (overrides: PrMetadata = {}): { data: unknown } {
  return {
    data: {
      draft: overrides.draft ?? false,
      labels: (overrides.labels ?? []).map((name) => ({ name })),
      title: overrides.title ?? 'A pull request',
      body: overrides.body ?? 'PR description',
      head: { sha: overrides.headSha ?? 'headsha0000' }
    }
  }
}

/**
 * `internals.runEngine` replacement: real `selectEngine`/`DiffEngine`, fake
 * (non-network) provider. `buildResponse` lets each test control what
 * "the model" returns (or throws, for T6.16).
 */
export function runEngineWithFakeProvider (
  buildResponse: (req: CompletionRequest) => Promise<CompletionResponse> | CompletionResponse
) {
  return async (
    config: ResolvedConfig,
    context: GithubContext,
    pr: PrPhaseResult,
    diff: DiffPhaseResult
  ): Promise<EnginePhaseResult> => {
    const provider = createFakeProvider(buildResponse)
    const signal = AbortSignal.timeout(config.api.total_timeout_ms)
    const engine = await selectEngine(config, provider, signal, diff.target.files.length)
    const reviewContext: ReviewContext = {
      config,
      provider,
      target: diff.target,
      pr: { number: context.prNumber, title: pr.title, body: pr.body },
      signal
    }
    const reviewResult = await engine.review(reviewContext)
    return { reviewResult, engineName: engine.name }
  }
}

export { makeCompletionResponse }
