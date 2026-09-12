import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from './truncate.ts'

test('TZ5: content within the byte budget is returned unchanged', () => {
  assert.equal(truncate('hello', 100), 'hello')
})

test('TZ5: content over the byte budget is cut at that many bytes with an explicit marker', () => {
  const result = truncate('x'.repeat(1000), 50)
  assert.ok(Buffer.byteLength(result, 'utf8') > 50, 'the marker itself adds bytes past the cut point')
  assert.match(result, /truncated, output exceeded 50 bytes/)
  assert.equal(result.startsWith('x'.repeat(50)), true)
})

test('TZ5: truncation is measured in UTF-8 bytes, not JS string length — a multi-byte character ' +
  'counts as more than one byte', () => {
  // Each '€' is 3 bytes in UTF-8; 10 of them is 30 bytes, over a 10-byte budget.
  const result = truncate('€'.repeat(10), 10)
  assert.match(result, /truncated, output exceeded 10 bytes/)
})
