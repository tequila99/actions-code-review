import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksRussian, resolveReviewLanguage } from './language.ts'

// Дополнение B: PR-title-based auto-detect of review.language (en/ru only).

test('TB.1: looksRussian - real Russian PR title -> true', () => {
  assert.equal(
    looksRussian('[#66964375] Массовое изменение сдельных ставок по проектам и заданиям'),
    true
  )
})

test('TB.2: looksRussian - pure English title -> false', () => {
  assert.equal(looksRussian('Fix login bug'), false)
})

test('TB.3: looksRussian - empty string -> false', () => {
  assert.equal(looksRussian(''), false)
})

test('TB.4: looksRussian - title with no letters at all -> false', () => {
  assert.equal(looksRussian('JIRA-1234'), false)
})

test('TB.5: looksRussian - a single stray Cyrillic letter among Latin -> false (below the >=2 confidence threshold)', () => {
  assert.equal(looksRussian('Fix bug (я)'), false)
})

test('TB.6: looksRussian - Cyrillic/Latin letter-count parity -> false', () => {
  // "Баг" = 3 Cyrillic letters (Б, а, г), "fix" = 3 Latin letters (f, i, x).
  assert.equal(looksRussian('Баг fix'), false)
})

test('TB.7: resolveReviewLanguage - explicit language wins even over a clearly-Russian title', () => {
  const result = resolveReviewLanguage({
    explicitLanguage: 'fr',
    prTitle: '[#66964375] Массовое изменение сдельных ставок по проектам и заданиям',
    defaultLanguage: 'en'
  })
  assert.equal(result, 'fr')
})

test('TB.8: resolveReviewLanguage - no explicit language + Russian title -> "ru"', () => {
  const result = resolveReviewLanguage({
    explicitLanguage: undefined,
    prTitle: '[#66964375] Массовое изменение сдельных ставок по проектам и заданиям',
    defaultLanguage: 'en'
  })
  assert.equal(result, 'ru')
})

test('TB.9: resolveReviewLanguage - no explicit language + non-Russian title -> defaultLanguage', () => {
  const result = resolveReviewLanguage({
    explicitLanguage: undefined,
    prTitle: 'Fix login bug',
    defaultLanguage: 'en'
  })
  assert.equal(result, 'en')
})
