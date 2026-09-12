import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listFiles } from './list-files.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'

test('T7.19: list_files(\'src/**/*.ts\') returns a sorted, count-limited list', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/b.ts', '')
    await ws.write('src/a.ts', '')
    await ws.write('src/nested/c.ts', '')
    await ws.write('src/d.js', '')
    await ws.write('README.md', '')
    const result = await listFiles({ glob: 'src/**/*.ts' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'src/a.ts\nsrc/b.ts\nsrc/nested/c.ts')
  })
})

test('T7.20: list_files with a pattern matching nothing returns an empty list, not an error', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', '')
    const result = await listFiles({ glob: '*.nonexistent' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.match(result.content, /no files matched/)
  })
})

test('TO.4: list_files never descends into node_modules/dist, even with a broad glob', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', '')
    await ws.write('node_modules/pkg/index.ts', '')
    await ws.write('dist/bundle.ts', '')
    const result = await listFiles({ glob: '**/*.ts' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'src/a.ts')
  })
})

test('TW.15: list_files("*.ts") finds nested files, not just the repository root', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('api/src/services/ewa.ts', '')
    await ws.write('web/src/App.vue', '')
    await ws.write('.github/workflows/ai-review.yaml', '')
    const result = await listFiles({ glob: '*.{ts,vue}' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'api/src/services/ewa.ts\nweb/src/App.vue')

    const dotDir = await listFiles({ glob: '.github/**/*.yaml' }, makeToolContext(ws.root))
    assert.equal(dotDir.content, '.github/workflows/ai-review.yaml')
  })
})
