import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatReviewEntry,
  formatJobSummary,
  escapeMarkdown,
  ENTRY_START,
  ENTRY_END
} from './format.ts'
import type { Finding } from '../engine/types.ts'

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

const DEFAULT_STARTED_AT = '2026-01-01T00:00:00.000Z'

function baseParams (overrides: Partial<Parameters<typeof formatReviewEntry>[0]> = {}) {
  return {
    postedFindings: [],
    unpostedFindings: [],
    notes: [],
    truncated: false,
    skippedFiles: [],
    tokensInput: 0,
    tokensOutput: 0,
    mode: 'diff',
    model: 'gpt-4o-mini',
    costEstimateUsd: '',
    filesReviewed: 0,
    severityMax: 'none' as const,
    findingsFiltered: 0,
    reviewId: 123,
    startedAt: DEFAULT_STARTED_AT,
    ...overrides
  }
}

// T5.39 previously asserted `STICKY_MARKER` was present in the summary
// output. Дополнение C moved the top-level sticky marker (and all
// history/entry-concatenation concerns) entirely into
// `github/sticky-comment.ts#buildStickyBody` — `formatReviewEntry` only
// builds a single entry's content, so asserting `STICKY_MARKER` here would
// be meaningless (and indeed, would now fail: it is never produced by this
// module). Replaced by TC.6 below, which asserts the entry delimiters this
// module *does* own.

test('TC.6: a review entry is wrapped in ENTRY_START/ENTRY_END delimiters', () => {
  const md = formatReviewEntry(baseParams())
  assert.ok(md.startsWith(ENTRY_START))
  assert.ok(md.endsWith(ENTRY_END))
  assert.ok(md.includes(ENTRY_START))
  assert.ok(md.includes(ENTRY_END))
})

test('TC.7: the header substitutes the real reviewId and startedAt', () => {
  const md = formatReviewEntry(
    baseParams({ reviewId: 4838288634, startedAt: '2026-08-02T14:35:00.000Z' })
  )
  assert.match(md, /### Review #4838288634 — 2026-08-02T14:35:00\.000Z/)
})

test('TC.8: reviewId null -> header renders "### Review #— — <startedAt>" (em dash placeholder)', () => {
  const md = formatReviewEntry(baseParams({ reviewId: null, startedAt: DEFAULT_STARTED_AT }))
  assert.match(md, /### Review #— — 2026-01-01T00:00:00\.000Z/)
})

test('T5.40: summary contains metrics - files, findings, tokens, mode, model', () => {
  const md = formatReviewEntry(
    baseParams({
      postedFindings: [finding()],
      filesReviewed: 3,
      tokensInput: 1234,
      tokensOutput: 567,
      mode: 'diff',
      model: 'gpt-4.1-mini'
    })
  )
  assert.match(md, /Files reviewed:\*\* 3/)
  assert.match(md, /Findings:\*\* 1/)
  assert.match(md, /in 1234 \/ out 567/)
  assert.match(md, /Mode:\*\* diff/)
  assert.match(md, /Model:\*\* gpt-4\.1-mini/)
})

test('T5.41: truncated true -> a "Not reviewed" section listing skipped files', () => {
  const md = formatReviewEntry(
    baseParams({ truncated: true, skippedFiles: [{ path: 'big.ts', reason: 'max_diff_bytes' }] })
  )
  assert.match(md, /Not reviewed/)
  assert.match(md, /big\.ts/)
  assert.match(md, /max_diff_bytes/)
})

test('T5.41b: truncated false -> no "Not reviewed" section', () => {
  const md = formatReviewEntry(baseParams({ truncated: false }))
  assert.ok(!md.includes('Not reviewed'))
})

test('T5.42: findings not posted inline are listed with path and line', () => {
  const md = formatReviewEntry(
    baseParams({ unpostedFindings: [finding({ path: 'b.ts', line: 42, message: 'oob' })] })
  )
  assert.match(md, /Findings not posted inline/)
  assert.match(md, /b\.ts:42/)
  assert.match(md, /oob/)
})

test('T5.43: notes[] are reflected in the summary', () => {
  const md = formatReviewEntry(baseParams({ notes: ['3 files were skipped due to budget'] }))
  assert.match(md, /Notes/)
  assert.match(md, /3 files were skipped due to budget/)
})

test('T5.44: job summary contains a findings table', () => {
  const md = formatJobSummary(
    baseParams({ postedFindings: [finding({ path: 'a.ts', line: 3, message: 'x issue' })] })
  )
  assert.match(md, /\| Severity \| Path \| Line \| Message \|/)
  assert.match(md, /\| medium \| a\.ts \| 3 \| x issue \|/)
})

test('T5.45: markdown-breaking characters in finding text are escaped', () => {
  const md = formatReviewEntry(baseParams({ unpostedFindings: [finding({ message: 'a | b\nc' })] }))
  // The raw pipe/newline must not appear unescaped inside the summary list item.
  assert.ok(!md.includes('a | b'))
  assert.match(md, /a \\\| b c/)
})

test('TI.5: a finding with a suggestion renders a ```suggestion fenced block', () => {
  const md = formatReviewEntry(
    baseParams({ unpostedFindings: [finding({ suggestion: 'const x = 2' })] })
  )
  assert.match(md, /```suggestion\n\s*const x = 2\n\s*```/)
})

test('TI.6: a finding without a suggestion renders unchanged (no fence)', () => {
  const md = formatReviewEntry(baseParams({ unpostedFindings: [finding()] }))
  assert.ok(!md.includes('```'))
})

test('escapeMarkdown escapes pipes, backslashes and newlines', () => {
  assert.equal(escapeMarkdown('a|b\\c\nd'), 'a\\|b\\\\c d')
})
