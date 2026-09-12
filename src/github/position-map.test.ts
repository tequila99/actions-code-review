import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPositionMap } from './position-map.ts'
import type { DiffFile } from './diff-parse.ts'

function makeFile (overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/a.ts',
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [
      {
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
    ],
    ...overrides
  }
}

test('T2.24: the built set contains every add AND context line of the hunk, not "-" lines', () => {
  const map = buildPositionMap([makeFile()])
  assert.equal(map.isValid('src/a.ts', 10), true) // context
  assert.equal(map.isValid('src/a.ts', 11), true) // add
  assert.equal(map.isValid('src/a.ts', 12), true) // add
  assert.equal(map.isValid('src/a.ts', 13), true) // context
})

test('T2.25: a line outside any hunk is invalid', () => {
  const map = buildPositionMap([makeFile()])
  assert.equal(map.isValid('src/a.ts', 999), false)
})

test('T2.26: a deleted line has no new-version line number and is never valid', () => {
  // A del line simply never contributes any number to the map at all.
  const delOnlyMap = buildPositionMap([
    makeFile({
      hunks: [
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 5,
          newLines: 0,
          lines: [{ type: 'del', content: 'gone', oldLineNumber: 5 }]
        }
      ]
    })
  ])
  assert.equal(delOnlyMap.isValid('src/a.ts', 5), false)
})

test('T2.27: a nonexistent path returns false, no throw', () => {
  const map = buildPositionMap([makeFile()])
  assert.doesNotThrow(() => map.isValid('src/does-not-exist.ts', 1))
  assert.equal(map.isValid('src/does-not-exist.ts', 1), false)
})

test('T2.28: a multi-line range where both boundaries are valid validates as-is', () => {
  const map = buildPositionMap([makeFile()])
  const result = map.validateRange('src/a.ts', 11, 13)
  assert.ok(result)
  assert.deepEqual(result, { startLine: 11, endLine: 13 })
})

test('T2.29: an invalid start_line collapses the range to a single line at end_line', () => {
  const map = buildPositionMap([makeFile()])
  // 5 is < endLine 13 (so this is not an inverted range, T2.30's concern) but
  // is not in the position map (the hunk only covers new-version lines 10-13).
  const result = map.validateRange('src/a.ts', 5, 13)
  assert.deepEqual(result, { startLine: 13, endLine: 13 })
})

test('T2.30: end_line < start_line is normalized (swapped), never throws', () => {
  const map = buildPositionMap([makeFile()])
  assert.doesNotThrow(() => map.validateRange('src/a.ts', 13, 11))
  const result = map.validateRange('src/a.ts', 13, 11)
  assert.deepEqual(result, { startLine: 11, endLine: 13 })
})

test('validateRange returns null when the (normalized) anchor line itself is invalid', () => {
  const map = buildPositionMap([makeFile()])
  assert.equal(map.validateRange('src/a.ts', 11, 999), null)
})

test('binary files contribute nothing to the position map', () => {
  const map = buildPositionMap([makeFile({ path: 'assets/logo.png', binary: true, hunks: [] })])
  assert.equal(map.isValid('assets/logo.png', 1), false)
})
