import { mock, type Mock } from 'node:test'
import type { OctokitClient } from '../../src/github/context.ts'

/**
 * Structural shape of the (tiny) slice of the Octokit REST client this
 * project depends on. `@actions/github`'s `getOctokit()` returns a fully
 * typed Octokit instance, but every module in `src/github/` accepts this
 * much smaller interface instead (dependency injection) so tests can pass a
 * plain object of `mock.fn()`s rather than fighting Octokit's real types or
 * its immutable ESM export surface.
 *
 * Each field is `Mock<F>` (node:test's own type: `F & { mock: ... }`) rather
 * than a loosely-typed `ReturnType<typeof mock.fn>`, so the object this
 * factory returns is structurally assignable to `OctokitClient` itself
 * (`get`/`listFiles`/etc. keep their real call signature) while tests can
 * still reach `.mock.mockImplementation(...)`/`.mock.calls`.
 */
export interface MockOctokit {
  rest: {
    pulls: {
      get: Mock<OctokitClient['rest']['pulls']['get']>
      listFiles: Mock<OctokitClient['rest']['pulls']['listFiles']>
      createReview: Mock<OctokitClient['rest']['pulls']['createReview']>
      listReviewComments: Mock<OctokitClient['rest']['pulls']['listReviewComments']>
    }
    repos: {
      compareCommits: Mock<OctokitClient['rest']['repos']['compareCommits']>
    }
    issues: {
      createComment: Mock<OctokitClient['rest']['issues']['createComment']>
      updateComment: Mock<OctokitClient['rest']['issues']['updateComment']>
      listComments: Mock<OctokitClient['rest']['issues']['listComments']>
    }
  }
}

/**
 * Builds a fake Octokit client whose REST methods are all `node:test`
 * `mock.fn()`s, defaulted to resolve with an empty/benign value so tests
 * that don't care about a particular method don't need to stub it. Override
 * any method's behaviour with `client.rest.<ns>.<method>.mock.mockImplementation(...)`.
 */
export function createOctokitMock (): MockOctokit {
  return {
    rest: {
      pulls: {
        get: mock.fn<OctokitClient['rest']['pulls']['get']>(async () => ({ data: '' })),
        listFiles: mock.fn<OctokitClient['rest']['pulls']['listFiles']>(async () => ({ data: [] })),
        createReview: mock.fn<OctokitClient['rest']['pulls']['createReview']>(async () => ({
          data: {}
        })),
        listReviewComments: mock.fn<OctokitClient['rest']['pulls']['listReviewComments']>(
          async () => ({
            data: []
          })
        )
      },
      repos: {
        compareCommits: mock.fn<OctokitClient['rest']['repos']['compareCommits']>(async () => ({
          data: ''
        }))
      },
      issues: {
        createComment: mock.fn<OctokitClient['rest']['issues']['createComment']>(async () => ({
          data: {}
        })),
        updateComment: mock.fn<OctokitClient['rest']['issues']['updateComment']>(async () => ({
          data: {}
        })),
        listComments: mock.fn<OctokitClient['rest']['issues']['listComments']>(async () => ({
          data: []
        }))
      }
    }
  }
}
