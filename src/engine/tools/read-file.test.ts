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
    // Below the TZ6 stat-size cutoff (toolOutputMaxBytes * 4 = 1200) so this exercises the
    // ordinary post-read truncation path, not the new "too large, ask for a range" refusal.
    await ws.write('big.ts', 'x'.repeat(1000))
    const ctx = makeToolContext(ws.root, { toolOutputMaxBytes: 300 })
    const result = await readFile({ path: 'big.ts' }, ctx)
    assert.equal(result.isError, false)
    assert.ok(Buffer.byteLength(result.content, 'utf8') < 1000)
    assert.match(result.content, /truncated/)
  })
})

test('TZ6: read_file of a file larger than tool_output_max_bytes * 4 with no start_line/end_line ' +
  'is refused, pointing the model at a specific range instead of reading the whole thing', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('huge.ts', 'x'.repeat(1000))
    const ctx = makeToolContext(ws.root, { toolOutputMaxBytes: 200 }) // cutoff: 200 * 4 = 800
    const result = await readFile({ path: 'huge.ts' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /start_line/)
    assert.match(result.content, /end_line/)
  })
})

test('TZ7: the same oversized file is still read in full when start_line/end_line are given — ' +
  'needed for correct 1-based line numbering even when only a slice is returned', async () => {
  await withTmpWorkspace(async (ws) => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`)
    await ws.write('huge.ts', lines.join('\n'))
    const ctx = makeToolContext(ws.root, { toolOutputMaxBytes: 200 }) // cutoff: 200 * 4 = 800
    const result = await readFile({ path: 'huge.ts', start_line: 250, end_line: 251 }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /^250: line 250/)
    assert.match(result.content, /251: line 251/)
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
