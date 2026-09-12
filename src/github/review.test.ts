import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishReview, listExistingReviewComments, formatCommentBody } from './review.ts'
import { createOctokitMock } from '../../test/helpers/octokit-mock.ts'
import { buildPositionMap } from './position-map.ts'
import type { DiffFile } from './diff-parse.ts'
import type { Finding } from '../engine/types.ts'
import { registerSecret } from '../util/secrets.ts'

function finding (overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'a.ts',
    line: 3,
    severity: 'medium',
    category: 'correctness',
    message: 'looks wrong',
    ...overrides
  }
}

/** A single file with one hunk whose new-version lines 1-5 (add/context) are valid. */
function samplePositionMap () {
  const files: DiffFile[] = [
    {
      path: 'a.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          lines: [
            { type: 'context', content: 'l1', newLineNumber: 1, oldLineNumber: 1 },
            { type: 'add', content: 'l2', newLineNumber: 2 },
            { type: 'add', content: 'l3', newLineNumber: 3 },
            { type: 'add', content: 'l4', newLineNumber: 4 },
            { type: 'context', content: 'l5', newLineNumber: 5, oldLineNumber: 2 }
          ]
        }
      ]
    }
  ]
  return buildPositionMap(files)
}

const baseParams = { owner: 'o', repo: 'r', prNumber: 1, model: 'openai/gpt-5.6-terra-pro' }

interface RawComment {
  path: string
  body: string
  line: number
  side: string
  start_line?: number
  start_side?: string
}

test('T5.1: 5 valid findings -> exactly one pulls.createReview call with 5 comments, event COMMENT', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 42 } }))
  const positionMap = samplePositionMap()
  const findings = [2, 3, 4, 3, 2].map((line, i) => finding({ line, message: `issue ${i}` }))

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 1)
  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    event: string
    comments: unknown[]
  }
  assert.equal(call.event, 'COMMENT')
  assert.equal(call.comments.length, 5)
  assert.equal(result.reviewId, 42)
  assert.equal(result.postedFindings.length, 5)
})

test('T5.2: a finding outside the diff positions is not sent inline, ends up in unpostedFindings', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 999, message: 'out of range' })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(result.postedFindings.length, 1)
  assert.equal(result.unpostedFindings.length, 1)
  assert.equal(result.unpostedFindings[0]!.line, 999)
  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as { comments: unknown[] }
  assert.equal(call.comments.length, 1)
})

test('T5.3: a multi-line finding sends start_line + line + side/start_side RIGHT', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2, endLine: 4 })]

  await publishReview(client, { ...baseParams, findings, positionMap, dryRun: false })

  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: RawComment[]
  }
  const comment = call.comments[0]!
  assert.deepEqual(
    {
      line: comment.line,
      start_line: comment.start_line,
      side: comment.side,
      start_side: comment.start_side
    },
    { line: 4, start_line: 2, side: 'RIGHT', start_side: 'RIGHT' }
  )
})

test('T5.4: a multi-line finding with an invalid start_line collapses to a single-line comment', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  // line=1 valid (context), but 0 (start) is out of range -> collapses to endLine only.
  const findings = [finding({ line: 0, endLine: 4 })]

  await publishReview(client, { ...baseParams, findings, positionMap, dryRun: false })

  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: RawComment[]
  }
  assert.equal(call.comments.length, 1)
  assert.equal(call.comments[0]!.line, 4)
  assert.equal(call.comments[0]!.start_line, undefined)
})

test('T5.5: createReview 422 -> fallback, no throw, all findings reported unposted', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Unprocessable Entity'), { status: 422 })
  })
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 3 })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(result.fallbackToSummaryOnly, true)
  assert.equal(result.reviewId, null)
  assert.equal(result.postedFindings.length, 0)
  assert.equal(result.unpostedFindings.length, 2)
})

test('TAA2: createReview 422 naming one comment by path:line -> that comment is dropped and createReview is retried exactly once', async () => {
  const client = createOctokitMock()
  let calls = 0
  client.rest.pulls.createReview.mock.mockImplementation(async () => {
    calls++
    if (calls === 1) {
      throw Object.assign(new Error('Unprocessable Entity'), {
        status: 422,
        response: {
          data: {
            errors: [{ message: 'Validation failed: a.ts:3 is not part of the diff' }]
          }
        }
      })
    }
    return { data: { id: 77 } }
  })
  const positionMap = samplePositionMap()
  const blamed = finding({ line: 3, message: 'blamed finding' })
  const clean = finding({ line: 2, message: 'clean finding' })
  const findings = [clean, blamed]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 2)
  const secondCall = client.rest.pulls.createReview.mock.calls[1]!.arguments[0] as {
    comments: RawComment[]
  }
  assert.equal(secondCall.comments.length, 1)
  assert.equal(secondCall.comments[0]!.line, 2)
  assert.equal(result.reviewId, 77)
  assert.equal(result.fallbackToSummaryOnly, false)
  assert.ok(!result.postedFindings.includes(blamed))
  assert.ok(result.postedFindings.includes(clean))
  assert.ok(result.unpostedFindings.includes(blamed))
  assert.ok(!result.unpostedFindings.includes(clean))
})

test('TAA3: createReview 422 with an unrecognizable error body -> old fallback, no retry', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Unprocessable Entity'), {
      status: 422,
      response: {
        data: {
          // A non-object, non-string entry (some GitHub error payloads mix
          // shapes) must be skipped rather than throwing.
          errors: [42, { message: 'Something went wrong, no idea which comment' }]
        }
      }
    })
  })
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 3 })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 1)
  assert.equal(result.fallbackToSummaryOnly, true)
  assert.equal(result.reviewId, null)
  assert.equal(result.postedFindings.length, 0)
  assert.equal(result.unpostedFindings.length, 2)
})

test('TAA3b: createReview 422 twice in a row (retry also rejected) -> falls back, no throw', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Unprocessable Entity'), {
      status: 422,
      response: {
        data: {
          errors: [{ message: 'Validation failed: a.ts:3 is not part of the diff' }]
        }
      }
    })
  })
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 3 })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 2)
  assert.equal(result.fallbackToSummaryOnly, true)
  assert.equal(result.reviewId, null)
  assert.equal(result.postedFindings.length, 0)
  assert.equal(result.unpostedFindings.length, 2)
})

test('T5.6: createReview 403 -> a clear GithubApiError mentioning pull-requests: write', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => {
    throw Object.assign(new Error('Forbidden'), { status: 403 })
  })
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 })]

  await assert.rejects(
    () => publishReview(client, { ...baseParams, findings, positionMap, dryRun: false }),
    (error: import('../util/errors.ts').GithubApiError) => {
      assert.match(error.toUserMessage(), /pull-requests: write/)
      return true
    }
  )
})

test('T5.7: every finding has an invalid position -> createReview is not called, all unposted', async () => {
  const client = createOctokitMock()
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 100 }), finding({ line: 200 })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 0)
  assert.equal(result.unpostedFindings.length, 2)
  assert.equal(result.postedFindings.length, 0)
})

test('T5.8: summary_only true -> inline comments are never sent', async () => {
  const client = createOctokitMock()
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 3 })]

  const result = await publishReview(client, {
    ...baseParams,
    findings,
    positionMap,
    dryRun: false,
    summaryOnly: true
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 0)
  assert.equal(result.postedFindings.length, 0)
  assert.equal(result.unpostedFindings.length, 2)
})

test('T5.9: dry_run true -> not a single mutating API call (FR-68), split is still computed', async () => {
  const client = createOctokitMock()
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 }), finding({ line: 999 })]

  const result = await publishReview(client, { ...baseParams, findings, positionMap, dryRun: true })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 0)
  assert.equal(result.postedFindings.length, 1)
  assert.equal(result.unpostedFindings.length, 1)
  assert.equal(result.reviewId, null)
})

test('T5.10: a finding text containing a registered secret is redacted before being sent', async () => {
  registerSecret('sekret-value-1234567890')
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2, message: 'leaked sekret-value-1234567890 in this line' })]

  await publishReview(client, { ...baseParams, findings, positionMap, dryRun: false })

  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: RawComment[]
  }
  assert.ok(!call.comments[0]!.body.includes('sekret-value-1234567890'))
  assert.ok(call.comments[0]!.body.includes('***'))
})

test('T5.11: findings is empty -> createReview is not called', async () => {
  const client = createOctokitMock()
  const positionMap = samplePositionMap()

  const result = await publishReview(client, {
    ...baseParams,
    findings: [],
    positionMap,
    dryRun: false
  })

  assert.equal(client.rest.pulls.createReview.mock.calls.length, 0)
  assert.equal(result.postedFindings.length, 0)
  assert.equal(result.unpostedFindings.length, 0)
})

test('TE.1: formatCommentBody emits no code fence when the finding has no suggestion (Дополнение D re-scoped this to AgentEngine-only, see TODO.md)', () => {
  const body = formatCommentBody(finding(), 'openai/gpt-5.6-terra-pro')
  assert.ok(!body.includes('```'), `body must never contain a code fence:\n${body}`)
})

test('TI.8: formatCommentBody renders a finding with a suggestion as a GitHub-native ```suggestion fence', () => {
  const body = formatCommentBody(finding({ suggestion: 'const x = 2' }), 'openai/gpt-5.6-terra-pro')
  assert.match(body, /```suggestion\nconst x = 2\n```/)
})

test('TI.9: a review published with a suggestion on a finding -> the posted comment body carries the suggestion fence', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2, suggestion: 'const x = 2' })]

  await publishReview(client, { ...baseParams, findings, positionMap, dryRun: false })

  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: RawComment[]
  }
  assert.match(call.comments[0]!.body, /```suggestion\nconst x = 2\n```/)
})

test('TG.1: formatCommentBody appends the model name in a <sub> footer, separate from the main message', () => {
  const body = formatCommentBody(finding(), 'openai/gpt-5.6-terra-pro')
  assert.match(body, /<sub>[^<]*openai\/gpt-5\.6-terra-pro[^<]*<\/sub>/)
})

test('TG.2: a review published with model "z-ai/glm-5.2" -> every posted comment body carries that model name in its footer', async () => {
  const client = createOctokitMock()
  client.rest.pulls.createReview.mock.mockImplementation(async () => ({ data: { id: 1 } }))
  const positionMap = samplePositionMap()
  const findings = [finding({ line: 2 })]

  await publishReview(client, {
    ...baseParams,
    model: 'z-ai/glm-5.2',
    findings,
    positionMap,
    dryRun: false
  })

  const call = client.rest.pulls.createReview.mock.calls[0]!.arguments[0] as {
    comments: RawComment[]
  }
  assert.match(call.comments[0]!.body, /<sub>[^<]*z-ai\/glm-5\.2[^<]*<\/sub>/)
})

test('T5.13: listExistingReviewComments follows pagination across 2 pages', async () => {
  const client = createOctokitMock()
  let call = 0
  client.rest.pulls.listReviewComments.mock.mockImplementation(async () => {
    call++
    if (call === 1) {
      return {
        data: Array.from({ length: 100 }, (_, i) => ({ path: 'a.ts', line: i + 1, body: `c${i}` }))
      }
    }
    return { data: [{ path: 'a.ts', line: 200, body: 'last' }] }
  })

  const result = await listExistingReviewComments(client, baseParams)

  assert.equal(result.length, 101)
  assert.equal(client.rest.pulls.listReviewComments.mock.calls.length, 2)
  assert.equal(result[100]!.body, 'last')
})
