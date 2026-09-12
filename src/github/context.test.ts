import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGithubContext, internals, type WebhookContextLike } from './context.ts'
import { GithubApiError } from '../util/errors.ts'

function validContext (): WebhookContextLike {
  return {
    eventName: 'pull_request',
    payload: {
      pull_request: { number: 42 },
      repository: { name: 'actions-code-review', owner: { login: 'tequila99' } }
    }
  }
}

test('T2.1: a valid pull_request payload extracts {owner, repo, prNumber} correctly', (t) => {
  t.mock.method(internals, 'getOctokit', () => ({ rest: {} }) as unknown)
  const ctx = createGithubContext('gh-token-value', validContext())
  assert.equal(ctx.owner, 'tequila99')
  assert.equal(ctx.repo, 'actions-code-review')
  assert.equal(ctx.prNumber, 42)
})

test('T2.2: getOctokit is called with the passed token', (t) => {
  const getOctokit = t.mock.method(internals, 'getOctokit', () => ({ rest: {} }) as unknown)
  createGithubContext('my-secret-token', validContext())
  assert.equal(getOctokit.mock.calls.length, 1)
  assert.equal(getOctokit.mock.calls[0]?.arguments[0], 'my-secret-token')
})

test('T2.3: payload without pull_request throws a clear GithubApiError, not a TypeError', () => {
  const ctx: WebhookContextLike = {
    eventName: 'pull_request',
    payload: { repository: { name: 'r', owner: { login: 'o' } } }
  }
  assert.throws(
    () => createGithubContext('t', ctx),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError)
      assert.ok(!(err instanceof TypeError))
      assert.ok((err as Error).message.includes('pull_request'))
      return true
    }
  )
})

test('T2.4: a workflow_dispatch event is rejected with a clear error naming the unsupported event', () => {
  const ctx: WebhookContextLike = {
    eventName: 'workflow_dispatch',
    payload: {}
  }
  assert.throws(
    () => createGithubContext('t', ctx),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError)
      assert.ok(!(err instanceof TypeError))
      assert.ok((err as Error).message.includes('workflow_dispatch'))
      return true
    }
  )
})
