import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grep } from './grep.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'

test('T7.21: grep finds matches as path:line:text, limited in count and size', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const needle = 1\nother line\n')
    await ws.write('src/b.ts', 'nothing here\n')
    const result = await grep({ pattern: 'needle' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'src/a.ts:1:const needle = 1')
  })
})

test('T7.22: an invalid regex is a result-error, not an exception', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'x')
    const result = await grep({ pattern: '(unclosed' }, makeToolContext(ws.root))
    assert.equal(result.isError, true)
    assert.match(result.content, /invalid pattern/)
  })
})

test('T7.23: a catastrophic regex is rejected up front, not executed (ReDoS)', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', `${'a'.repeat(40)}!`)
    const start = Date.now()
    const result = await grep({ pattern: '(a+)+$' }, makeToolContext(ws.root))
    const elapsed = Date.now() - start
    assert.equal(result.isError, true)
    assert.match(result.content, /catastrophic/)
    assert.ok(elapsed < 1000, `expected a fast rejection, took ${elapsed}ms`)
  })
})

test('TU.2: grep({ glob: \'\' }) is treated as no glob, not "match nothing" — some models (e.g. ' +
  'GPT-5.6-family via OpenRouter) send an empty string for an omitted optional parameter instead of ' +
  'leaving it out', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const needle = 1\n')
    const result = await grep({ pattern: 'needle', glob: '' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'src/a.ts:1:const needle = 1')
  })
})

test('TO.3: grep never descends into node_modules/dist, even without an explicit glob', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const needle = 1\n')
    await ws.write('node_modules/pkg/index.js', 'const needle = 1\n')
    await ws.write('dist/bundle.js', 'const needle = 1\n')
    const result = await grep({ pattern: 'needle' }, makeToolContext(ws.root))
    assert.equal(result.isError, false)
    assert.equal(result.content, 'src/a.ts:1:const needle = 1')
  })
})

test('TW.16: grep with a bare "*.ts"-style glob searches nested files — a real trace got ' +
  '"(no matches)" over a repo of nothing but .ts/.vue and fell back to reading files one by one', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('api/src/services/ewa.ts', 'const CANCEL_EXECUTOR_INVITE = 1\n')
    await ws.write('web/src/App.vue', '<script>inviteExecutor()</script>\n')
    await ws.write('README.md', 'inviteExecutor\n')
    const result = await grep(
      { pattern: 'inviteExecutor|CANCEL_EXECUTOR_INVITE', glob: '*.{ts,vue}' },
      makeToolContext(ws.root)
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /api\/src\/services\/ewa\.ts:1:/)
    assert.match(result.content, /web\/src\/App\.vue:1:/)
    assert.doesNotMatch(result.content, /README\.md/)
  })
})
