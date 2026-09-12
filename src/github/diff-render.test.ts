import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderHunk, renderFile } from './diff-render.ts'
import type { DiffHunk } from './diff-parse.ts'

function makeHunk (): DiffHunk {
  return {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    lines: [
      { type: 'context', content: 'a', oldLineNumber: 10, newLineNumber: 10 },
      { type: 'del', content: 'old', oldLineNumber: 11 },
      { type: 'add', content: 'new1', newLineNumber: 11 },
      { type: 'add', content: 'new2', newLineNumber: 12 },
      { type: 'context', content: 'b', oldLineNumber: 12, newLineNumber: 13 }
    ]
  }
}

test('T2.31: each new-version line is prefixed with its line number, in a stable documented format', () => {
  const output = renderHunk(makeHunk(), 3)
  assert.ok(output.includes('    11 | new1'), output)
  assert.ok(output.includes('    12 | new2'), output)
  assert.ok(output.includes('    10 | a'), output)
})

test('T2.32: deleted lines are marked but carry no new-version line number', () => {
  const output = renderHunk(makeHunk(), 3)
  const delLine = output.split('\n').find((l) => l.includes('old'))!
  assert.ok(delLine.startsWith('-'), delLine)
  assert.ok(!/\d/.test(delLine.split('|')[0]!), 'no digit before the separator on a del line')
})

test('T2.33: context_lines: 0 shows no context lines; context_lines: 3 keeps them', () => {
  const hunk: DiffHunk = {
    oldStart: 1,
    oldLines: 7,
    newStart: 1,
    newLines: 7,
    lines: [
      { type: 'context', content: 'c1', newLineNumber: 1, oldLineNumber: 1 },
      { type: 'context', content: 'c2', newLineNumber: 2, oldLineNumber: 2 },
      { type: 'context', content: 'c3', newLineNumber: 3, oldLineNumber: 3 },
      { type: 'add', content: 'changed', newLineNumber: 4 },
      { type: 'context', content: 'c5', newLineNumber: 5, oldLineNumber: 5 },
      { type: 'context', content: 'c6', newLineNumber: 6, oldLineNumber: 6 },
      { type: 'context', content: 'c7', newLineNumber: 7, oldLineNumber: 7 }
    ]
  }

  const withZero = renderHunk(hunk, 0)
  assert.equal(withZero.includes('c1'), false)
  assert.equal(withZero.includes('c3'), false)
  assert.equal(withZero.includes('changed'), true)

  const withThree = renderHunk(hunk, 3)
  assert.equal(withThree.includes('c1'), true)
  assert.equal(withThree.includes('c7'), true)
})

test('TE.5: contextLines above the old 10-line cap (e.g. 20) is honored, not silently re-clamped to 10 (must track the raised filters.context_lines bound, config/schema.ts: 0..30)', () => {
  const lines: DiffHunk['lines'] = []
  for (let i = 1; i <= 15; i++) {
    lines.push({ type: 'context', content: `before${i}`, newLineNumber: i, oldLineNumber: i })
  }
  lines.push({ type: 'add', content: 'changed', newLineNumber: 16 })
  for (let i = 17; i <= 31; i++) {
    lines.push({ type: 'context', content: `after${i}`, newLineNumber: i, oldLineNumber: i })
  }
  const hunk: DiffHunk = { oldStart: 1, oldLines: 30, newStart: 1, newLines: 31, lines }

  const output = renderHunk(hunk, 20)
  // 20 lines of context on each side of the change at line 16 reaches
  // before1 (16-20 < 1, so before1..before15 all fall within 20) and after36
  // doesn't exist, but after17..after31 (15 lines) all fall within 20.
  assert.ok(output.includes('before1'), `expected context beyond the old 10-line cap:\n${output}`)
  assert.ok(output.includes('after31'), `expected context beyond the old 10-line cap:\n${output}`)
})

test('T2.34: a purely deleting patch collapses into a compact form (no per-line dump)', () => {
  const hunk: DiffHunk = {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 0,
    lines: [
      { type: 'del', content: 'gone1', oldLineNumber: 1 },
      { type: 'del', content: 'gone2', oldLineNumber: 2 },
      { type: 'del', content: 'gone3', oldLineNumber: 3 }
    ]
  }
  const output = renderHunk(hunk, 3)
  assert.equal(output.includes('gone1'), false)
  assert.ok(/removed/.test(output))
})

test('T2.35: rendering is deterministic — calling twice on the same input yields identical output', () => {
  const hunk = makeHunk()
  assert.equal(renderHunk(hunk, 3), renderHunk(hunk, 3))
  const file = {
    path: 'src/a.ts',
    oldPath: null,
    status: 'modified' as const,
    binary: false,
    hunks: [hunk]
  }
  assert.equal(renderFile(file, 3), renderFile(file, 3))
})

test('renderFile: a binary file is rendered as a placeholder, not per-line content', () => {
  const file = {
    path: 'assets/logo.png',
    oldPath: null,
    status: 'modified' as const,
    binary: true,
    hunks: []
  }
  assert.ok(renderFile(file).includes('binary'))
})
