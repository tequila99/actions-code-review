import { test } from 'node:test'
import assert from 'node:assert/strict'
import { walkWorkspace } from './walk.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'

test('TO.1: walkWorkspace skips known vendor/build directories by exact name', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', '')
    await ws.write('node_modules/pkg/index.js', '')
    await ws.write('dist/bundle.js', '')
    await ws.write('build/out.js', '')
    const out: string[] = []
    await walkWorkspace(ws.root, ws.root, out)
    assert.deepEqual(out.sort(), ['src/a.ts'])
  })
})

test('TO.2: a directory whose name only contains "node_modules" as a substring is not skipped', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('my_node_modules_backup/a.ts', '')
    const out: string[] = []
    await walkWorkspace(ws.root, ws.root, out)
    assert.deepEqual(out, ['my_node_modules_backup/a.ts'])
  })
})
