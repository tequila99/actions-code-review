import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAndValidateFinding, normalizeFindings, defaultSummary, isDefaultSummary } from './findings.ts'

const VALID_PATHS = new Set(['src/a.ts', 'src/b.ts'])

function okRaw (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/a.ts',
    line: 10,
    severity: 'medium',
    category: 'correctness',
    message: 'Off-by-one error.',
    ...overrides
  }
}

test('a well-formed finding is accepted as-is', () => {
  const result = normalizeAndValidateFinding(okRaw(), VALID_PATHS)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.finding, {
      path: 'src/a.ts',
      line: 10,
      severity: 'medium',
      category: 'correctness',
      message: 'Off-by-one error.'
    })
    assert.equal(result.warning, undefined)
  }
})

test('end_line is carried through when present and valid', () => {
  const result = normalizeAndValidateFinding(okRaw({ end_line: 12 }), VALID_PATHS)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.finding.endLine, 12)
  }
})

test('TF.1: a raw "suggestion" field is ignored entirely — the feature was removed (unreliable given diff-only context, see TODO.md)', () => {
  const result = normalizeAndValidateFinding(okRaw({ suggestion: 'Use <= instead.' }), VALID_PATHS)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.ok(!('suggestion' in result.finding), 'Finding must never carry a suggestion field')
  }
})

test('a finding with a missing or non-string path is dropped', () => {
  const raw = okRaw()
  delete raw.path
  assert.equal(normalizeAndValidateFinding(raw, VALID_PATHS).ok, false)
  assert.equal(normalizeAndValidateFinding(okRaw({ path: 42 }), VALID_PATHS).ok, false)
  assert.equal(normalizeAndValidateFinding(okRaw({ path: '' }), VALID_PATHS).ok, false)
})

test('a finding referencing an unknown path is dropped', () => {
  const result = normalizeAndValidateFinding(okRaw({ path: 'src/does-not-exist.ts' }), VALID_PATHS)
  assert.equal(result.ok, false)
})

test('line: 0 is dropped', () => {
  const result = normalizeAndValidateFinding(okRaw({ line: 0 }), VALID_PATHS)
  assert.equal(result.ok, false)
})

test('a negative line is dropped', () => {
  const result = normalizeAndValidateFinding(okRaw({ line: -5 }), VALID_PATHS)
  assert.equal(result.ok, false)
})

test('a non-numeric line is dropped', () => {
  const result = normalizeAndValidateFinding(okRaw({ line: 'ten' }), VALID_PATHS)
  assert.equal(result.ok, false)
})

test('an unknown severity is normalized to "info" with a warning', () => {
  const result = normalizeAndValidateFinding(okRaw({ severity: 'catastrophic' }), VALID_PATHS)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.finding.severity, 'info')
    assert.ok(result.warning?.includes('catastrophic'))
  }
})

test('a missing message is dropped', () => {
  const raw = okRaw()
  delete raw.message
  const result = normalizeAndValidateFinding(raw, VALID_PATHS)
  assert.equal(result.ok, false)
})

test('a blank message is dropped', () => {
  const result = normalizeAndValidateFinding(okRaw({ message: '   ' }), VALID_PATHS)
  assert.equal(result.ok, false)
})

test('a missing/blank category is normalized to "general"', () => {
  const raw = okRaw()
  delete raw.category
  const result = normalizeAndValidateFinding(raw, VALID_PATHS)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.finding.category, 'general')
})

test('a non-object raw value is dropped', () => {
  assert.equal(normalizeAndValidateFinding('not an object', VALID_PATHS).ok, false)
  assert.equal(normalizeAndValidateFinding(null, VALID_PATHS).ok, false)
  assert.equal(normalizeAndValidateFinding([1, 2, 3], VALID_PATHS).ok, false)
})

test('normalizeFindings batches validation, invoking onWarning/onDrop and keeping only valid findings', () => {
  const warnings: string[] = []
  const drops: string[] = []
  const findings = normalizeFindings(
    [
      okRaw({ path: 'src/a.ts', line: 1 }),
      okRaw({ path: 'src/b.ts', line: 2, severity: 'weird' }),
      okRaw({ path: 'not-in-batch.ts', line: 3 }),
      { path: 'src/a.ts', line: 4 } // missing message
    ],
    VALID_PATHS,
    { onWarning: (m) => warnings.push(m), onDrop: (r) => drops.push(r) }
  )
  assert.equal(findings.length, 2)
  assert.equal(warnings.length, 1)
  assert.equal(drops.length, 2)
})

test('TAD.13: isDefaultSummary recognises every text defaultSummary can produce, and only those', () => {
  const finding = { path: 'a.ts', line: 1, severity: 'low' as const, category: 'x', message: 'm' }
  assert.equal(isDefaultSummary(defaultSummary([])), true)
  assert.equal(isDefaultSummary(defaultSummary([finding])), true)
  assert.equal(isDefaultSummary(defaultSummary([finding, finding, finding])), true)
  assert.equal(isDefaultSummary('The change looks fine overall.'), false)
  assert.equal(isDefaultSummary('No issues found. But the auth flow is fragile.'), false)
  assert.equal(isDefaultSummary(''), false)
})
