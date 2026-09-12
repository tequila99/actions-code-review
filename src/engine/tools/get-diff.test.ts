import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDiff } from './get-diff.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'
import type { DiffFile } from '../../github/diff-parse.ts'

const FILE_A: DiffFile = {
  path: 'src/a.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: [
        { type: 'context', content: 'unchanged', newLineNumber: 1, oldLineNumber: 1 },
        { type: 'add', content: 'new line', newLineNumber: 2 }
      ]
    }
  ]
}

const FILE_B: DiffFile = {
  path: 'src/b.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{ type: 'add', content: 'b content', newLineNumber: 1 }]
    }
  ]
}

test('T7.24: get_diff() with no argument returns the whole PR diff', async () => {
  const ctx = makeToolContext('/tmp/whatever', { target: { files: [FILE_A, FILE_B], skipped: [] } })
  const result = await getDiff({}, ctx)
  assert.equal(result.isError, false)
  assert.match(result.content, /src\/a\.ts/)
  assert.match(result.content, /src\/b\.ts/)
})

test('T7.25: get_diff(path) returns only that file\'s diff', async () => {
  const ctx = makeToolContext('/tmp/whatever', { target: { files: [FILE_A, FILE_B], skipped: [] } })
  const result = await getDiff({ path: 'src/a.ts' }, ctx)
  assert.equal(result.isError, false)
  assert.match(result.content, /new line/)
  assert.doesNotMatch(result.content, /b content/)
})

test('TU.1: get_diff({ path: \'\' }) is treated as no argument, not an error — some models (e.g. ' +
  'GPT-5.6-family via OpenRouter, confirmed on a real production trace) send an empty string for an ' +
  'omitted optional parameter instead of leaving it out', async () => {
  const ctx = makeToolContext('/tmp/whatever', { target: { files: [FILE_A, FILE_B], skipped: [] } })
  const result = await getDiff({ path: '' }, ctx)
  assert.equal(result.isError, false)
  assert.match(result.content, /src\/a\.ts/)
  assert.match(result.content, /src\/b\.ts/)
})

test('T7.26: get_diff of a file not in the PR is a result-error', async () => {
  const ctx = makeToolContext('/tmp/whatever', { target: { files: [FILE_A], skipped: [] } })
  const result = await getDiff({ path: 'src/nonexistent.ts' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /not one of the files/)
})

test('T7.27: tool output over tool_output_max_bytes is truncated with an explicit marker', async () => {
  const ctx = makeToolContext('/tmp/whatever', {
    target: { files: [FILE_A, FILE_B], skipped: [] },
    toolOutputMaxBytes: 20
  })
  const result = await getDiff({}, ctx)
  assert.equal(result.isError, false)
  assert.match(result.content, /truncated/)
})

test('TW.17: get_diff of a file dropped by the select-files limits says so, and says read_file ' +
  'still works — "not one of the files in this pull request\'s diff" reads as "not in the PR" and ' +
  'made a real trace go back and re-check the same path twice', async () => {
  const ctx = makeToolContext('/tmp/whatever', {
    target: { files: [FILE_A], skipped: [{ path: 'web/src/Big.vue', reason: 'max_files' }] }
  })
  const result = await getDiff({ path: 'web/src/Big.vue' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /max_files/)
  assert.match(result.content, /read_file/)
  assert.doesNotMatch(result.content, /not one of the files/)
})

test('TW.18: get_diff of a path in neither list points the model back at the file inventory', async () => {
  const ctx = makeToolContext('/tmp/whatever', {
    target: { files: [FILE_A], skipped: [{ path: 'web/src/Big.vue', reason: 'max_files' }] }
  })
  const result = await getDiff({ path: 'src/imagined.ts' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /not one of the files/)
  assert.match(result.content, /list of files/i)
})
