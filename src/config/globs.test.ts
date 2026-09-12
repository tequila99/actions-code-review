import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFileIncluded,
  matchPathInstructions,
  matchContextLayers,
  normalizePath
} from './globs.ts'
import { DEFAULT_EXCLUDE } from './defaults.ts'

test('T1.41: empty include lets every file pass', () => {
  assert.equal(isFileIncluded('src/a.ts', [], []), true)
  assert.equal(isFileIncluded('docs/a.md', [], []), true)
})

test("T1.42: include: ['src/**'] matches src/a.ts but not docs/a.md", () => {
  assert.equal(isFileIncluded('src/a.ts', ['src/**'], []), true)
  assert.equal(isFileIncluded('docs/a.md', ['src/**'], []), false)
})

test('T1.43: a file matched by both include and exclude is excluded (exclude wins, FR-11)', () => {
  assert.equal(isFileIncluded('src/generated/a.ts', ['src/**'], ['src/generated/**']), false)
})

test('T1.44: the default exclude list catches lock files, minified assets, dist/**, images', () => {
  assert.equal(isFileIncluded('package-lock.json', [], DEFAULT_EXCLUDE), false)
  assert.equal(isFileIncluded('a.min.js', [], DEFAULT_EXCLUDE), false)
  assert.equal(isFileIncluded('dist/x.js', [], DEFAULT_EXCLUDE), false)
  assert.equal(isFileIncluded('logo.png', [], DEFAULT_EXCLUDE), false)
})

test('T1.45: a file matching 2 path_instructions patterns returns both, in declaration order', () => {
  const instructions = [
    { path: 'src/db/**', instructions: 'db instructions' },
    { path: 'src/**', instructions: 'generic src instructions' },
    { path: 'apps/**', instructions: 'apps instructions' }
  ]
  const matched = matchPathInstructions('src/db/migrations/001.ts', instructions)
  assert.deepEqual(
    matched.map((m) => m.instructions),
    ['db instructions', 'generic src instructions']
  )
})

test('T1.46: no path_instructions match returns an empty array', () => {
  const instructions = [{ path: 'apps/**', instructions: 'apps instructions' }]
  assert.deepEqual(matchPathInstructions('src/a.ts', instructions), [])
})

test('T1.47: leading "./" is normalized the same as no leading "./"', () => {
  assert.equal(normalizePath('./src/a.ts'), normalizePath('src/a.ts'))
  assert.equal(
    isFileIncluded('./src/a.ts', ['src/**'], []),
    isFileIncluded('src/a.ts', ['src/**'], [])
  )
})

test('T1.48: context.layers matches src/db/x.ts to .claude/context/db.md', () => {
  const layers = [
    { path: 'src/db/**', context_files: ['.claude/context/db.md'] },
    { path: 'apps/web/**', context_files: ['.claude/context/frontend.md'] }
  ]
  assert.deepEqual(matchContextLayers('src/db/x.ts', layers), ['.claude/context/db.md'])
})
