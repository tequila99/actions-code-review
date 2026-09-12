import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesGlob } from './glob-match.ts'

test('TW.12: a glob with no slash matches on the basename at any depth', () => {
  assert.equal(matchesGlob('api/src/services/ewa.ts', '*.ts'), true)
  assert.equal(matchesGlob('api/src/services/ewa.ts', '*.{ts,vue}'), true)
  assert.equal(matchesGlob('web/src/App.vue', '*.{ts,vue}'), true)
  assert.equal(matchesGlob('README.md', '*.ts'), false)
})

test('TW.13: a glob that does contain a slash keeps its literal path meaning', () => {
  assert.equal(matchesGlob('api/src/a.ts', 'api/**/*.ts'), true)
  assert.equal(matchesGlob('web/src/a.ts', 'api/**/*.ts'), false)
  // Would match on basename, but the glob is path-shaped, so it must not.
  assert.equal(matchesGlob('web/src/deep/a.ts', 'src/*.ts'), false)
})

test('TW.14: globs reach into dot-directories — .github/workflows/*.yaml is ordinary PR content', () => {
  assert.equal(matchesGlob('.github/workflows/ai-review.yaml', '**/*.yaml'), true)
  assert.equal(matchesGlob('.github/workflows/ai-review.yaml', '.github/**'), true)
  assert.equal(matchesGlob('.github/workflows/ai-review.yaml', '*.yaml'), true)
})
