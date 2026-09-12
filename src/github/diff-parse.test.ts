import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDiff, parseHunks } from './diff-parse.ts'

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures/diff/', import.meta.url))

function loadFixture (name: string): string {
  return readFileSync(FIXTURES_DIR + name, 'utf8')
}

test('T2.10: simple diff, one file, one hunk', () => {
  const files = parseDiff(loadFixture('simple-single-hunk.diff'))
  assert.equal(files.length, 1)
  const file = files[0]!
  assert.equal(file.path, 'src/greet.ts')
  assert.equal(file.status, 'modified')
  assert.equal(file.hunks.length, 1)
  const hunk = file.hunks[0]!
  assert.equal(hunk.oldStart, 1)
  assert.equal(hunk.oldLines, 3)
  assert.equal(hunk.newStart, 1)
  assert.equal(hunk.newLines, 4)
  assert.deepEqual(
    hunk.lines.map((l) => l.type),
    ['context', 'del', 'add', 'add', 'context']
  )
})

test('T2.11: multiple files, multiple hunks each, all recognized with correct paths', () => {
  const files = parseDiff(loadFixture('multi-file-multi-hunk.diff'))
  assert.equal(files.length, 2)
  assert.equal(files[0]!.path, 'src/a.ts')
  assert.equal(files[0]!.hunks.length, 2)
  assert.equal(files[1]!.path, 'src/b.ts')
  assert.equal(files[1]!.hunks.length, 2)
  assert.equal(files[1]!.hunks[1]!.newLines, 3)
})

test('T2.12: new file (--- /dev/null) -> status added, oldPath null', () => {
  const files = parseDiff(loadFixture('new-file.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.status, 'added')
  assert.equal(files[0]!.oldPath, null)
  assert.equal(files[0]!.path, 'src/new-module.ts')
})

test('T2.13: deleted file (+++ /dev/null) -> status deleted', () => {
  const files = parseDiff(loadFixture('deleted-file.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.status, 'deleted')
  assert.equal(files[0]!.path, 'src/old-module.ts')
})

test('T2.14: rename (rename from/to) -> status renamed, both paths present', () => {
  const files = parseDiff(loadFixture('renamed-file.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.status, 'renamed')
  assert.equal(files[0]!.oldPath, 'src/legacy/helper.ts')
  assert.equal(files[0]!.path, 'src/utils/helper.ts')
  assert.equal(files[0]!.hunks.length, 1)
})

test('T2.15: mode change only (old mode/new mode), no content change -> file recognized, 0 hunks, no throw', () => {
  const files = parseDiff(loadFixture('mode-change-only.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'scripts/run.sh')
  assert.equal(files[0]!.hunks.length, 0)
})

test('T2.16: binary file (Binary files ... differ) -> binary: true, excluded from review', () => {
  const files = parseDiff(loadFixture('binary-file.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.binary, true)
  assert.equal(files[0]!.path, 'assets/logo.png')
  assert.equal(files[0]!.hunks.length, 0)
})

test('T2.17: "\\ No newline at end of file" does not break line numbering', () => {
  const files = parseDiff(loadFixture('no-newline-eof.diff'))
  assert.equal(files.length, 1)
  const hunk = files[0]!.hunks[0]!
  assert.deepEqual(
    hunk.lines.map((l) => l.type),
    ['context', 'del', 'add']
  )
  const addLine = hunk.lines.find((l) => l.type === 'add')!
  assert.equal(addLine.newLineNumber, 2)
  assert.equal(addLine.content, 'const y = 3')
})

test('T2.18: paths with spaces and Cyrillic characters are parsed correctly', () => {
  const files = parseDiff(loadFixture('paths-spaces-cyrillic.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'src/папка с пробелами/файл.ts')
  const hunk = files[0]!.hunks[0]!
  assert.equal(hunk.lines[0]!.content, "export const привет = 'старый'")
})

test('T2.19: empty diff ("") -> empty array, no throw', () => {
  assert.deepEqual(parseDiff(''), [])
})

test('T2.20: diff with CRLF line endings is parsed correctly', () => {
  const files = parseDiff(loadFixture('crlf.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'src/crlf.ts')
  const hunk = files[0]!.hunks[0]!
  assert.deepEqual(
    hunk.lines.map((l) => l.type),
    ['context', 'del', 'add']
  )
  assert.equal(hunk.lines[1]!.content, 'const y = 2')
})

test('T2.21: file with 3+ scattered hunks -> all hunks recognized, boundaries not confused', () => {
  const files = parseDiff(loadFixture('three-plus-hunks.diff'))
  assert.equal(files.length, 1)
  const hunks = files[0]!.hunks
  assert.equal(hunks.length, 4)
  assert.deepEqual(
    hunks.map((h) => h.oldStart),
    [1, 10, 20, 30]
  )
  assert.equal(hunks[2]!.lines[0]!.content, 'gamma old')
})

test('T2.22: path containing "b/" inside the filename -> a/ b/ prefixes stripped correctly', () => {
  const files = parseDiff(loadFixture('path-with-b-slash.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'src/b/foo.ts')
})

test('T2.23: content lines starting with "--" or "++" are not mistaken for file headers', () => {
  const files = parseDiff(loadFixture('content-dashes.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'notes.txt')
  const hunk = files[0]!.hunks[0]!
  assert.deepEqual(
    hunk.lines.map((l) => l.type),
    ['context', 'del', 'add']
  )
  assert.equal(hunk.lines[1]!.content, '-- old dash note')
  assert.equal(hunk.lines[2]!.content, '++ new plus note')
})

test('parseHunks: parses a standalone pulls.listFiles "patch" string (no file-level headers)', () => {
  const hunks = parseHunks('@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3')
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0]!.oldStart, 1)
  assert.deepEqual(
    hunks[0]!.lines.map((l) => l.type),
    ['context', 'del', 'add']
  )
})

test('manual check (C2.3): a synthetic 500+ line diff parses without error and yields non-empty hunks', () => {
  const text = loadFixture('large-synthetic-500-lines.diff')
  assert.ok(text.split('\n').length >= 500)
  const files = parseDiff(text)
  assert.equal(files.length, 22)
  for (const file of files) {
    assert.ok(file.hunks.length > 0)
  }
})
