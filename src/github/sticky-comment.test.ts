import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findStickyComment,
  extractStickyState,
  upsertStickyComment,
  buildStickyBody,
  buildStateBlock,
  STICKY_MARKER,
  STICKY_HISTORY_MAX_ENTRIES,
  GITHUB_COMMENT_MAX_CHARS
} from './sticky-comment.ts'
import { ENTRY_START, ENTRY_END } from '../report/format.ts'
import { logger } from '../util/logger.ts'
import { createOctokitMock } from '../../test/helpers/octokit-mock.ts'

/** Builds a fake, well-formed history entry carrying a unique marker for order assertions. */
function fakeEntry (id: string): string {
  return `${ENTRY_START}\n### Review #${id}\n- fake entry ${id}\n${ENTRY_END}`
}

const PARAMS = { owner: 'tequila99', repo: 'actions-code-review', prNumber: 42 }

test('T2.5: no comment carries the marker -> null, no throw', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [
      { id: 1, body: 'just a regular comment' },
      { id: 2, body: 'another one, no marker here' }
    ]
  }))
  const result = await findStickyComment(client, PARAMS)
  assert.equal(result, null)
})

test('T2.6: the sticky comment is found among other comments, with its id and body', async () => {
  const client = createOctokitMock()
  const stickyBody = `## Review summary\n\n${STICKY_MARKER}\nSome text.`
  client.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [
      { id: 1, body: 'unrelated comment' },
      { id: 2, body: stickyBody },
      { id: 3, body: 'another unrelated comment' }
    ]
  }))
  const result = await findStickyComment(client, PARAMS)
  assert.ok(result)
  assert.equal(result.id, 2)
  assert.equal(result.body, stickyBody)
})

test('T2.7: last_reviewed_sha is correctly extracted from the state block', () => {
  const body =
    `## Review summary\n${STICKY_MARKER}\n` +
    '<!-- actions-code-review:state {"last_reviewed_sha":"abc123","version":1} -->'
  const state = extractStickyState(body)
  assert.deepEqual(state, { last_reviewed_sha: 'abc123', version: 1 })
})

test('T2.8: the found comment has no state block -> null, no throw', () => {
  const body = `## Review summary\n${STICKY_MARKER}\nNo state block here.`
  assert.doesNotThrow(() => extractStickyState(body))
  assert.equal(extractStickyState(body), null)
})

test('T2.9: a state block with malformed JSON -> null + warning (fallback to full diff, FR-17)', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const body = `${STICKY_MARKER}\n<!-- actions-code-review:state {not valid json} -->`
  const result = extractStickyState(body)
  assert.equal(result, null)
  assert.equal(warning.mock.calls.length, 1)
})

test('a state block missing required fields -> null + warning, no throw', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const body = `${STICKY_MARKER}\n<!-- actions-code-review:state {"version":1} -->`
  assert.equal(extractStickyState(body), null)
  assert.equal(warning.mock.calls.length, 1)
})

test('multiple comments carry the marker -> the earliest is used, a warning is logged, no throw', async (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [
      { id: 10, body: `first ${STICKY_MARKER}` },
      { id: 20, body: `second ${STICKY_MARKER}` }
    ]
  }))
  const result = await findStickyComment(client, PARAMS)
  assert.ok(result)
  assert.equal(result.id, 10)
  assert.equal(warning.mock.calls.length, 1)
})

test('listComments pagination: two full pages of 100 are both read', async () => {
  const client = createOctokitMock()
  let calls = 0
  client.rest.issues.listComments.mock.mockImplementation(async () => {
    calls++
    if (calls === 1) {
      return { data: Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' })) }
    }
    if (calls === 2) {
      return {
        data: [
          ...Array.from({ length: 99 }, (_, i) => ({ id: 100 + i, body: 'x' })),
          { id: 999, body: `sticky ${STICKY_MARKER}` }
        ]
      }
    }
    return { data: [] }
  })
  const result = await findStickyComment(client, PARAMS)
  assert.ok(result)
  assert.equal(result.id, 999)
  // page 1: 100 items, page 2: exactly 100 items (99 + the sticky one) -> a
  // 3rd (empty) page must be fetched to detect the end of pagination.
  assert.equal(calls, 3)
})

// ---------------------------------------------------------------------------
// Write side (stage 5, T5.14-T5.20)
// ---------------------------------------------------------------------------

const STATE = { last_reviewed_sha: 'deadbeef', version: 1 }

test('T5.14: no comment carries the marker -> issues.createComment is called', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  client.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 7 } }))

  const result = await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: STATE,
    dryRun: false
  })

  assert.equal(client.rest.issues.createComment.mock.calls.length, 1)
  assert.equal(client.rest.issues.updateComment.mock.calls.length, 0)
  assert.equal(result.created, true)
  assert.equal(result.commentId, 7)
})

test('T5.15: an existing sticky comment -> issues.updateComment of the same id, createComment not called', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [{ id: 55, body: `old ${STICKY_MARKER}` }]
  }))

  const result = await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: STATE,
    dryRun: false
  })

  assert.equal(client.rest.issues.updateComment.mock.calls.length, 1)
  assert.equal(client.rest.issues.createComment.mock.calls.length, 0)
  const call = client.rest.issues.updateComment.mock.calls[0]!.arguments[0] as {
    comment_id: number
  }
  assert.equal(call.comment_id, 55)
  assert.equal(result.created, false)
  assert.equal(result.commentId, 55)
})

test('T5.16: multiple sticky comments (race) -> the earliest is updated, the rest untouched, warning logged', async (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({
    data: [
      { id: 10, body: `first ${STICKY_MARKER}` },
      { id: 20, body: `second ${STICKY_MARKER}` }
    ]
  }))

  await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: STATE,
    dryRun: false
  })

  assert.equal(client.rest.issues.updateComment.mock.calls.length, 1)
  const call = client.rest.issues.updateComment.mock.calls[0]!.arguments[0] as {
    comment_id: number
  }
  assert.equal(call.comment_id, 10)
  assert.equal(warning.mock.calls.length, 1)
})

test('T5.17: the written body contains the state block with last_reviewed_sha and version', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  client.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))

  await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: { last_reviewed_sha: 'abc123', version: 1 },
    dryRun: false
  })

  const call = client.rest.issues.createComment.mock.calls[0]!.arguments[0] as { body: string }
  assert.match(
    call.body,
    /<!-- actions-code-review:state \{"last_reviewed_sha":"abc123","version":1\} -->/
  )
})

test('T5.18: dry_run true -> no createComment/updateComment call at all', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))

  const result = await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: STATE,
    dryRun: true
  })

  assert.equal(client.rest.issues.createComment.mock.calls.length, 0)
  assert.equal(client.rest.issues.updateComment.mock.calls.length, 0)
  assert.equal(result.created, false)
})

test('T5.19: the marker is an HTML comment, invisible in rendered markdown', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  client.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))

  await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state: STATE,
    dryRun: false
  })

  const call = client.rest.issues.createComment.mock.calls[0]!.arguments[0] as { body: string }
  assert.match(STICKY_MARKER, /^<!--.*-->$/)
  assert.ok(call.body.includes(STICKY_MARKER))
})

test('T5.20: round-trip - writing then reading the state gives back the same values', async () => {
  const client = createOctokitMock()
  client.rest.issues.listComments.mock.mockImplementation(async () => ({ data: [] }))
  client.rest.issues.createComment.mock.mockImplementation(async () => ({ data: { id: 1 } }))

  const state = { last_reviewed_sha: 'roundtrip-sha', version: 1 }
  await upsertStickyComment(client, {
    ...PARAMS,
    entryMarkdown: `## Summary\n${STICKY_MARKER}`,
    state,
    dryRun: false
  })

  const call = client.rest.issues.createComment.mock.calls[0]!.arguments[0] as { body: string }
  assert.deepEqual(extractStickyState(call.body), state)
})

// ---------------------------------------------------------------------------
// Дополнение C: `buildStickyBody` - capped, newest-first run history.
// ---------------------------------------------------------------------------

function countEntries (body: string): number {
  const pattern = new RegExp(`${ENTRY_START}.*?${ENTRY_END}`, 'gs')
  return body.match(pattern)?.length ?? 0
}

test('TC.1: existingBody null -> exactly 1 entry, STICKY_MARKER and history heading present', () => {
  const body = buildStickyBody(null, fakeEntry('new'))
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes(STICKY_MARKER))
  assert.match(body, /## AI Code Review — History/)
})

test('TC.2: existing body with 1 valid entry -> 2 entries in the result, the new one first', () => {
  const existingBody = `${STICKY_MARKER}\n\n## AI Code Review — History\n\n${fakeEntry('old')}`
  const body = buildStickyBody(existingBody, fakeEntry('new'))
  assert.equal(countEntries(body), 2)
  const newIndex = body.indexOf('Review #new')
  const oldIndex = body.indexOf('Review #old')
  assert.ok(newIndex >= 0 && oldIndex >= 0)
  assert.ok(newIndex < oldIndex, 'the new entry must come before the old one')
})

test('TC.3: existing body with exactly STICKY_HISTORY_MAX_ENTRIES entries -> still exactly that many after adding a new one, oldest dropped, truncation note present (ru)', () => {
  const existingEntries = Array.from({ length: STICKY_HISTORY_MAX_ENTRIES }, (_, i) =>
    fakeEntry(`old-${i}`)
  )
  const existingBody =
    `${STICKY_MARKER}\n\n## AI Code Review — History\n\n` + existingEntries.join('\n\n')

  const body = buildStickyBody(existingBody, fakeEntry('new'), STICKY_HISTORY_MAX_ENTRIES, 'ru')

  assert.equal(countEntries(body), STICKY_HISTORY_MAX_ENTRIES)
  assert.ok(body.includes('Review #new'))
  // The very last (oldest) of the original entries must have been dropped.
  assert.ok(!body.includes(`Review #old-${STICKY_HISTORY_MAX_ENTRIES - 1}`))
  assert.ok(body.includes('Review #old-0'))
  assert.match(body, /Показаны последние 20 прогонов/)
})

test('TAB4: truncation note in a non-ru language is English, no Cyrillic', () => {
  const existingEntries = Array.from({ length: STICKY_HISTORY_MAX_ENTRIES }, (_, i) =>
    fakeEntry(`old-${i}`)
  )
  const existingBody =
    `${STICKY_MARKER}\n\n## AI Code Review — History\n\n` + existingEntries.join('\n\n')

  const body = buildStickyBody(existingBody, fakeEntry('new'), STICKY_HISTORY_MAX_ENTRIES, 'en')

  assert.match(body, /Showing the last 20 runs/)
  assert.doesNotMatch(body, /[а-яё]/i)
})

test('TAB5: truncation note defaults to English when language is omitted', () => {
  const existingEntries = Array.from({ length: STICKY_HISTORY_MAX_ENTRIES }, (_, i) =>
    fakeEntry(`old-${i}`)
  )
  const existingBody =
    `${STICKY_MARKER}\n\n## AI Code Review — History\n\n` + existingEntries.join('\n\n')

  const body = buildStickyBody(existingBody, fakeEntry('new'))

  assert.match(body, /Showing the last 20 runs/)
  // The "AI Code Review — History" header is a stable, unparsed English
  // marker regardless of language (never translated).
  assert.match(body, /## AI Code Review — History/)
})

test('TC.4: existing body without a single entry marker (old flat format) -> treated as 0 entries, result has exactly 1 (the new one)', () => {
  const oldFlatBody = `${STICKY_MARKER}\n\n## AI Code Review Summary\n\n- **Mode:** diff\n`
  const body = buildStickyBody(oldFlatBody, fakeEntry('new'))
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes('Review #new'))
})

test('TC.5: corrupted/unclosed entry marker (opening delimiter with no closing one) -> safe fallback, no throw, no garbage half-entry included', () => {
  const corruptedBody = `${STICKY_MARKER}\n\n## AI Code Review — History\n\n${ENTRY_START}\n### Review #broken\n- never closed`
  assert.doesNotThrow(() => buildStickyBody(corruptedBody, fakeEntry('new')))
  const body = buildStickyBody(corruptedBody, fakeEntry('new'))
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes('Review #new'))
  assert.ok(!body.includes('Review #broken'))
})

// ---------------------------------------------------------------------------
// #8: `GITHUB_COMMENT_MAX_CHARS` cap - the state block must always survive,
// oldest history entries are dropped first, and only the single remaining
// entry's own bulkiest optional sections get trimmed as a last resort.
// ---------------------------------------------------------------------------

/** A history entry padded to roughly `sizeBytes`, for exercising the char-budget cap. */
function bigFakeEntry (id: string, sizeBytes: number): string {
  return `${ENTRY_START}\n### Review #${id}\n${'x'.repeat(sizeBytes)}\n${ENTRY_END}`
}

test('TAB6: 20 history entries of ~5KB each + a new entry -> final body stays under the GitHub comment limit, state block preserved', () => {
  const existingEntries = Array.from({ length: 20 }, (_, i) => bigFakeEntry(`old-${i}`, 5000))
  const existingBody =
    `${STICKY_MARKER}\n\n## AI Code Review — History\n\n` + existingEntries.join('\n\n')
  const stateBlock = buildStateBlock({ last_reviewed_sha: 'deadbeef', version: 1 })

  const body = buildStickyBody(
    existingBody,
    bigFakeEntry('new', 5000),
    STICKY_HISTORY_MAX_ENTRIES,
    'en',
    stateBlock
  )

  assert.ok(body.length < GITHUB_COMMENT_MAX_CHARS, `body length was ${body.length}`)
  assert.ok(body.includes(stateBlock))
})

test('TAB7: a single entry alone exceeds the char budget -> its Findings/Notes sections are trimmed, entry stays well-formed', () => {
  const findingLines = Array.from({ length: 3000 }, (_, i) => `- finding number ${i} `.padEnd(30, 'x'))
  const noteLines = Array.from({ length: 3000 }, (_, i) => `- note number ${i} `.padEnd(30, 'x'))
  const hugeEntry = [
    ENTRY_START,
    '',
    '### Review #1 — 2026-01-01',
    '',
    '- **Mode:** diff',
    '',
    '### Findings not posted inline',
    ...findingLines,
    '',
    '### Notes',
    ...noteLines,
    '',
    ENTRY_END
  ].join('\n')
  const stateBlock = buildStateBlock({ last_reviewed_sha: 'deadbeef', version: 1 })

  const body = buildStickyBody(null, hugeEntry, STICKY_HISTORY_MAX_ENTRIES, 'en', stateBlock)

  assert.ok(body.length < GITHUB_COMMENT_MAX_CHARS, `body length was ${body.length}`)
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes(stateBlock))
})

test('TAB8: buildStickyBody without a stateBlock arg behaves exactly as before (no budget cap kicks in unnecessarily)', () => {
  const body = buildStickyBody(null, fakeEntry('new'))
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes(STICKY_MARKER))
})

test('TAB9: a single oversized entry with no Findings/Notes sections to trim -> hard-truncated before the closing delimiter, still well-formed', () => {
  const stateBlock = buildStateBlock({ last_reviewed_sha: 'deadbeef', version: 1 })
  const hugeEntry = `${ENTRY_START}\n### Review #1\n${'x'.repeat(200000)}\n${ENTRY_END}`

  const body = buildStickyBody(null, hugeEntry, STICKY_HISTORY_MAX_ENTRIES, 'en', stateBlock)

  assert.ok(body.length < GITHUB_COMMENT_MAX_CHARS, `body length was ${body.length}`)
  assert.equal(countEntries(body), 1)
  assert.ok(body.includes(stateBlock))
  assert.match(body, /trimmed: exceeds the GitHub comment length limit/)
})
