import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeFindings } from './dedupe.ts'
import type { Finding } from '../engine/types.ts'

function finding (overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'a.ts',
    line: 10,
    severity: 'medium',
    category: 'correctness',
    message: 'Off by one error here',
    ...overrides
  }
}

test('T5.21: two findings with identical path+line+text -> one remains', () => {
  const result = dedupeFindings([finding(), finding()])
  assert.equal(result.length, 1)
})

test('T5.22: same path+line, different text -> both remain', () => {
  const result = dedupeFindings([
    finding({ message: 'first issue' }),
    finding({ message: 'second issue' })
  ])
  assert.equal(result.length, 2)
})

test('T5.23: texts differing only by whitespace/case are treated as duplicates', () => {
  const result = dedupeFindings([
    finding({ message: 'Off by ONE error here' }),
    finding({ message: '  off by one   error here  ' })
  ])
  assert.equal(result.length, 1)
})

test('T5.24: a finding matching an already-posted PR comment is not republished', () => {
  const result = dedupeFindings(
    [finding({ message: 'Off by one error here' })],
    [{ path: 'a.ts', line: 10, body: '**MEDIUM** (correctness): Off by one error here' }]
  )
  assert.equal(result.length, 0)
})

test('T5.24b: an existing comment at a different path/line does not suppress the finding', () => {
  const result = dedupeFindings(
    [finding()],
    [{ path: 'b.ts', line: 10, body: 'Off by one error here' }]
  )
  assert.equal(result.length, 1)
})

test('TAA4: a multi-line finding matches an existing comment at endLine (GitHub\'s posted `line` is the range end, not the start)', () => {
  const result = dedupeFindings(
    [finding({ line: 10, endLine: 14, message: 'Off by one error here' })],
    [{ path: 'a.ts', line: 14, body: '**MEDIUM** (correctness): Off by one error here' }]
  )
  assert.equal(result.length, 0)
})

test('TAA4b: a multi-line finding is not suppressed by an existing comment at its startLine', () => {
  const result = dedupeFindings(
    [finding({ line: 10, endLine: 14, message: 'Off by one error here' })],
    [{ path: 'a.ts', line: 10, body: '**MEDIUM** (correctness): Off by one error here' }]
  )
  assert.equal(result.length, 1)
})

test('T5.25: dedup is stable - order preserved, first occurrence kept', () => {
  const first = finding({ message: 'dup', path: 'x.ts', line: 1 })
  const second = finding({ message: 'unique', path: 'x.ts', line: 2 })
  const thirdDup = finding({ message: 'dup', path: 'x.ts', line: 1 })
  const result = dedupeFindings([first, second, thirdDup])
  assert.equal(result.length, 2)
  assert.equal(result[0], first)
  assert.equal(result[1], second)
})
