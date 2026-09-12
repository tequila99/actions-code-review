import { test } from 'node:test'
import assert from 'node:assert/strict'
import { severityMax, shouldFail, sortAndTruncate } from './severity.ts'
import type { Finding } from '../engine/types.ts'

function finding (overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'a.ts',
    line: 1,
    severity: 'info',
    category: 'style',
    message: 'msg',
    ...overrides
  }
}

test('T5.26: fail_on_severity "none" with a high finding present -> false', () => {
  assert.equal(shouldFail([finding({ severity: 'high' })], 'none'), false)
})

test('T5.27: fail_on_severity "high", a high finding is present -> true', () => {
  assert.equal(shouldFail([finding({ severity: 'high' })], 'high'), true)
})

test('T5.28: fail_on_severity "high", max is medium -> false', () => {
  assert.equal(
    shouldFail([finding({ severity: 'medium' }), finding({ severity: 'low' })], 'high'),
    false
  )
})

test('T5.29: fail_on_severity "medium", a medium finding is present -> true', () => {
  assert.equal(shouldFail([finding({ severity: 'medium' })], 'medium'), true)
})

test('T5.29b: fail_on_severity "medium", a high finding is present -> true (medium OR high)', () => {
  assert.equal(shouldFail([finding({ severity: 'high' })], 'medium'), true)
})

test('T5.29c: fail_on_severity "medium", only low/info present -> false', () => {
  assert.equal(
    shouldFail([finding({ severity: 'low' }), finding({ severity: 'info' })], 'medium'),
    false
  )
})

test('T5.30: severityMax is correct for every combination, "none" for empty', () => {
  assert.equal(severityMax([]), 'none')
  assert.equal(severityMax([finding({ severity: 'info' })]), 'info')
  assert.equal(severityMax([finding({ severity: 'low' }), finding({ severity: 'info' })]), 'low')
  assert.equal(
    severityMax([
      finding({ severity: 'medium' }),
      finding({ severity: 'low' }),
      finding({ severity: 'info' })
    ]),
    'medium'
  )
  assert.equal(
    severityMax([
      finding({ severity: 'high' }),
      finding({ severity: 'medium' }),
      finding({ severity: 'low' }),
      finding({ severity: 'info' })
    ]),
    'high'
  )
})

test('T5.31: sort order is high -> medium -> low -> info, tie-broken by path then line', () => {
  const findings: Finding[] = [
    finding({ severity: 'low', path: 'b.ts', line: 1 }),
    finding({ severity: 'high', path: 'z.ts', line: 5 }),
    finding({ severity: 'high', path: 'a.ts', line: 9 }),
    finding({ severity: 'high', path: 'a.ts', line: 2 }),
    finding({ severity: 'medium', path: 'a.ts', line: 1 }),
    finding({ severity: 'info', path: 'a.ts', line: 1 })
  ]
  const { kept } = sortAndTruncate(findings, findings.length)
  assert.deepEqual(
    kept.map((f) => `${f.severity}:${f.path}:${f.line}`),
    ['high:a.ts:2', 'high:a.ts:9', 'high:z.ts:5', 'medium:a.ts:1', 'low:b.ts:1', 'info:a.ts:1']
  )
})

test('T5.32: truncation to max_comments happens after sorting, keeps the most severe, exposes overflow', () => {
  const findings: Finding[] = [
    finding({ severity: 'info', path: 'a.ts', line: 1 }),
    finding({ severity: 'high', path: 'b.ts', line: 1 }),
    finding({ severity: 'medium', path: 'c.ts', line: 1 }),
    finding({ severity: 'low', path: 'd.ts', line: 1 })
  ]
  const { kept, overflow } = sortAndTruncate(findings, 2)
  assert.deepEqual(
    kept.map((f) => f.severity),
    ['high', 'medium']
  )
  assert.deepEqual(
    overflow.map((f) => f.severity),
    ['low', 'info']
  )
})
