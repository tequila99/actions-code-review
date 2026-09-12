import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectFiles, type SelectFilesParams } from './select-files.ts'
import type { DiffFile } from './diff-parse.ts'

function makeAddFile (path: string, contentLength = 10): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ type: 'add', content: 'x'.repeat(contentLength), newLineNumber: 1 }]
      }
    ]
  }
}

function makeDeletionFile (path: string, contentLength = 10): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 0,
        newLines: 0,
        lines: [{ type: 'del', content: 'x'.repeat(contentLength), oldLineNumber: 1 }]
      }
    ]
  }
}

function baseParams (overrides: Partial<SelectFilesParams> = {}): SelectFilesParams {
  return {
    files: [],
    include: [],
    exclude: [],
    maxFiles: 50,
    maxDiffBytes: 1_000_000,
    pathInstructions: [],
    ...overrides
  }
}

test('T2.44: 100 files, max_files: 50 -> 50 reviewed, 50 skipped, truncated: true', () => {
  const files = Array.from({ length: 100 }, (_, i) => makeAddFile(`src/file_${i}.ts`))
  const result = selectFiles(baseParams({ files, maxFiles: 50 }))
  assert.equal(result.files.length, 50)
  assert.equal(result.skipped.length, 50)
  assert.equal(result.truncated, true)
})

test('T2.45: diff exceeding max_diff_bytes -> the tail goes to skipped, truncated: true', () => {
  const files = Array.from({ length: 10 }, (_, i) => makeAddFile(`src/file_${i}.ts`, 100))
  // Each file is ~101 bytes; a budget of 300 bytes leaves room for ~2-3 files.
  const result = selectFiles(baseParams({ files, maxFiles: 50, maxDiffBytes: 300 }))
  assert.ok(result.files.length < 10)
  assert.ok(result.skipped.length > 0)
  assert.equal(result.truncated, true)
  assert.ok(result.skipped.every((s) => s.reason === 'max_diff_bytes'))
})

test('T2.46: a file matched by path_instructions is prioritized ahead of others on overflow', () => {
  const files = [
    makeAddFile('src/plain_a.ts'),
    makeAddFile('src/plain_b.ts'),
    makeAddFile('src/important.ts')
  ]
  const result = selectFiles(
    baseParams({
      files,
      maxFiles: 1,
      pathInstructions: [{ path: 'src/important.ts', instructions: 'review carefully' }]
    })
  )
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['src/important.ts']
  )
})

test('T2.47: main-language detection prioritizes the majority extension (10 .ts vs 2 .md, no API calls)', () => {
  const tsFiles = Array.from({ length: 10 }, (_, i) => makeAddFile(`src/file_${i}.ts`))
  const mdFiles = [makeAddFile('docs/a.md'), makeAddFile('docs/b.md')]
  const result = selectFiles(baseParams({ files: [...mdFiles, ...tsFiles], maxFiles: 12 }))
  const paths = result.files.map((f) => f.path)
  const lastTsIndex = Math.max(...paths.map((p, i) => (p.endsWith('.ts') ? i : -1)))
  const firstMdIndex = paths.findIndex((p) => p.endsWith('.md'))
  assert.ok(lastTsIndex < firstMdIndex, `expected all .ts before .md, got: ${paths.join(', ')}`)
})

test('T2.48: pure-deletion patches sort to the end', () => {
  const files = [
    makeDeletionFile('src/deleted_a.ts'),
    makeAddFile('src/kept_a.ts'),
    makeDeletionFile('src/deleted_b.ts'),
    makeAddFile('src/kept_b.ts')
  ]
  const result = selectFiles(baseParams({ files, maxFiles: 4 }))
  const paths = result.files.map((f) => f.path)
  assert.deepEqual(paths.slice(-2).sort(), ['src/deleted_a.ts', 'src/deleted_b.ts'])
})

test('T2.49: binary and excluded files are not counted toward max_files, and never appear in skipped', () => {
  const binaryFile: DiffFile = {
    path: 'assets/logo.png',
    oldPath: null,
    status: 'modified',
    binary: true,
    hunks: []
  }
  const excludedFile = makeAddFile('dist/bundle.js')
  const reviewable = [makeAddFile('src/a.ts'), makeAddFile('src/b.ts')]

  const result = selectFiles(
    baseParams({
      files: [binaryFile, excludedFile, ...reviewable],
      exclude: ['dist/**'],
      maxFiles: 50
    })
  )

  assert.equal(result.files.length, 2)
  assert.equal(result.skipped.length, 0)
  assert.equal(result.truncated, false)
})

test('T2.50: every file filtered out -> empty result + skippedReason: "no_changes"', () => {
  const files = [makeAddFile('dist/bundle.js'), makeAddFile('dist/other.js')]
  const result = selectFiles(baseParams({ files, exclude: ['dist/**'] }))
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.truncated, false)
  assert.equal(result.skippedReason, 'no_changes')
})
