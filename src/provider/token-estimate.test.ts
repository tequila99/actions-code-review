import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens } from './token-estimate.ts'

function repeatTo (phrase: string, length: number): string {
  const repeated = phrase.repeat(Math.ceil(length / phrase.length))
  return repeated.slice(0, length)
}

const PROSE_PHRASE = 'the quick brown fox jumps over the lazy dog and runs away quickly '
const CODE_PHRASE = 'function foo(a,b){return a+b;} if(a>b){x=[1,2,3];} '
const CYRILLIC_PHRASE = 'привет как дела у тебя все хорошо надеюсь что всё в порядке сегодня '

test('T3.43: ASCII prose estimate is within +/-30% of the ~4 chars/token empirical reference', () => {
  const text = repeatTo(PROSE_PHRASE, 400)
  const reference = text.length / 4
  const estimate = estimateTokens(text)
  assert.ok(
    estimate >= reference * 0.7 && estimate <= reference * 1.3,
    `estimate ${estimate} not within +/-30% of reference ${reference}`
  )
})

test('T3.44: code estimate differs from prose estimate of the same character length', () => {
  const prose = repeatTo(PROSE_PHRASE, 400)
  const code = repeatTo(CODE_PHRASE, 400)
  assert.equal(prose.length, code.length)
  assert.notEqual(estimateTokens(code), estimateTokens(prose))
  assert.ok(
    estimateTokens(code) > estimateTokens(prose),
    'denser code text should estimate more tokens'
  )
})

test('T3.45: Cyrillic estimate is greater than ASCII estimate of the same character length', () => {
  const ascii = repeatTo(PROSE_PHRASE, 400)
  const cyrillic = repeatTo(CYRILLIC_PHRASE, 400)
  assert.equal(ascii.length, cyrillic.length)
  assert.ok(estimateTokens(cyrillic) > estimateTokens(ascii))
})

test('T3.46: empty string estimates to 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('T3.47: monotonicity — a longer input never estimates fewer tokens', () => {
  const shorter = repeatTo(PROSE_PHRASE, 200)
  const longer = shorter + repeatTo(PROSE_PHRASE, 300)
  assert.ok(estimateTokens(longer) >= estimateTokens(shorter))

  const shorterCode = repeatTo(CODE_PHRASE, 150)
  const longerCode = shorterCode + repeatTo(CODE_PHRASE, 250)
  assert.ok(estimateTokens(longerCode) >= estimateTokens(shorterCode))
})
