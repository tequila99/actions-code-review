import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from './read-file.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'

test('T7.14: read_file of an existing file returns content with line numbers', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('a.ts', 'line one\nline two\n')
    const result = await readFile({ path: 'a.ts' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, '1: line one\n2: line two\n3: ')
  })
})

test('T7.15: read_file with start_line/end_line returns only that range', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('a.ts', 'one\ntwo\nthree\nfour\n')
    const result = await readFile({ path: 'a.ts', start_line: 2, end_line: 3 }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, '2: two\n3: three')
  })
})

test('T7.16: read_file of a nonexistent file is a result-error, not an exception', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await readFile({ path: 'missing.ts' }, makeToolContext(ws.root))
    assert.equal(result.isError, true)
    assert.match(result.content, /not found/)
  })
})

test('T7.17: read_file of a file larger than tool_output_max_bytes is truncated with a marker', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('big.ts', 'x'.repeat(1000))
    const ctx = makeToolContext(ws.root, { toolOutputMaxBytes: 50 })
    const result = await readFile({ path: 'big.ts' }, ctx)
    assert.equal(result.isError, false)
    assert.ok(Buffer.byteLength(result.content, 'utf8') < 1000)
    assert.match(result.content, /truncated/)
  })
})

test('T7.18: read_file of a binary file is refused with a clear message', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    const result = await readFile({ path: 'image.png' }, makeToolContext(ws.root))
    assert.equal(result.isError, true)
    assert.match(result.content, /binary/)
  })
})
