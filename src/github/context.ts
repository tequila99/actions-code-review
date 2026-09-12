import * as github from '@actions/github'
import { GithubApiError } from '../util/errors.ts'

/**
 * Structural shape of the (tiny) slice of the Octokit REST client every
 * module in `src/github/` depends on. Every function that needs GitHub
 * access takes this as a parameter (dependency injection) instead of
 * calling `github.getOctokit()` itself, so tests can pass a plain object of
 * `mock.fn()`s (`test/helpers/octokit-mock.ts`) instead of fighting
 * Octokit's real types or `@actions/github`'s immutable ESM export surface.
 */
export interface OctokitClient {
  rest: {
    pulls: {
      get(params: Record<string, unknown>): Promise<{ data: unknown }>
      listFiles(params: Record<string, unknown>): Promise<{ data: unknown[] }>
      createReview(params: Record<string, unknown>): Promise<{ data: unknown }>
      /** Stage 5 (FR-65, R-9): already-posted inline review comments, for dedup. */
      listReviewComments(params: Record<string, unknown>): Promise<{ data: unknown[] }>
    }
    repos: {
      compareCommits(params: Record<string, unknown>): Promise<{ data: unknown }>
    }
    issues: {
      createComment(params: Record<string, unknown>): Promise<{ data: unknown }>
      updateComment(params: Record<string, unknown>): Promise<{ data: unknown }>
      listComments(params: Record<string, unknown>): Promise<{ data: unknown[] }>
    }
  }
}

export interface GithubContext {
  client: OctokitClient
  owner: string
  repo: string
  prNumber: number
}

/** Minimal shape of `github.context` this module reads (testable without the real singleton). */
export interface WebhookContextLike {
  eventName: string
  payload: {
    pull_request?: { number: number }
    repository?: { name: string; owner: { login: string } }
  }
}

/**
 * Mutable seam for tests. `@actions/github`'s `getOctokit` is a named export
 * of a pure ESM package and cannot be monkey-patched with
 * `t.mock.method(github, 'getOctokit', ...)` ("Cannot redefine property"),
 * same rationale as `src/main.ts`/`src/util/secrets.ts`.
 */
export const internals = {
  getOctokit (token: string): OctokitClient {
    return github.getOctokit(token) as unknown as OctokitClient
  }
}

function extractPullRequestInfo (ctx: WebhookContextLike): {
  owner: string
  repo: string
  prNumber: number
} {
  if (ctx.eventName !== 'pull_request') {
    throw new GithubApiError(
      `Unsupported event "${ctx.eventName}"; this action only reads pull request info from the "pull_request" event.`,
      'Trigger this action from a `pull_request` (or `pull_request_target`-style) workflow event.'
    )
  }
  const pr = ctx.payload.pull_request
  if (!pr) {
    throw new GithubApiError(
      'Event payload is missing "pull_request".',
      'This usually means the workflow ran on an unexpected event; check the `on:` block of the calling workflow.'
    )
  }
  const repository = ctx.payload.repository
  if (!repository) {
    throw new GithubApiError('Event payload is missing "repository".')
  }
  return { owner: repository.owner.login, repo: repository.name, prNumber: pr.number }
}

/**
 * Builds the `GithubContext` (client + owner/repo/prNumber) used throughout
 * `src/github/**`. `ctx` defaults to the real `@actions/github` singleton,
 * but tests always pass a fake `WebhookContextLike` (T2.1-T2.4).
 */
export function createGithubContext (token: string, ctx: WebhookContextLike): GithubContext {
  const { owner, repo, prNumber } = extractPullRequestInfo(ctx)
  const client = internals.getOctokit(token)
  return { client, owner, repo, prNumber }
}
