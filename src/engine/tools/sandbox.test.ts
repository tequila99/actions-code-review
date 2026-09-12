import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveSandboxPath } from './sandbox.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'

test('T7.1: read_file(\'src/a.ts\') resolves from the workspace root', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'x')
    const result = await resolveSandboxPath('src/a.ts', ws.root)
    assert.equal(result.ok, true)
    assert.equal((result as { absolutePath: string }).absolutePath, path.join(ws.root, 'src/a.ts'))
  })
})

test('T7.2: \'../../../etc/passwd\' is refused', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('../../../etc/passwd', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.3: an absolute path is refused', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('/etc/passwd', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.4: \'src/../../outside.txt\' is refused (normalized before checking)', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('src/../../outside.txt', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.5: \'~/.ssh/id_rsa\' is refused', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('~/.ssh/id_rsa', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.6: a symlink inside the workspace pointing outside it is refused', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('../outside.txt', 'secret')
    await ws.symlink(path.join(ws.root, '..', 'outside.txt'), 'link.txt')
    const result = await resolveSandboxPath('link.txt', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.7: \'.git/config\' is refused (deny-list, THR-6)', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('.git/config', '[core]')
    const result = await resolveSandboxPath('.git/config', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.8: \'.env\', \'.env.local\', \'.env.production\' are refused', async () => {
  await withTmpWorkspace(async (ws) => {
    for (const name of ['.env', '.env.local', '.env.production']) {
      const result = await resolveSandboxPath(name, ws.root)
      assert.equal(result.ok, false, `${name} should be refused`)
    }
  })
})

test('T7.9: \'key.pem\', \'id_rsa\', \'credentials.json\' are refused', async () => {
  await withTmpWorkspace(async (ws) => {
    for (const name of ['key.pem', 'id_rsa', 'credentials.json']) {
      const result = await resolveSandboxPath(name, ws.root)
      assert.equal(result.ok, false, `${name} should be refused`)
    }
  })
})

test('T7.10: the deny-list cannot be overridden — resolveSandboxPath takes no such parameter', async () => {
  await withTmpWorkspace(async (ws) => {
    // No `include`/allowlist argument exists on the function signature at
    // all — this test documents that a caller has no way to pass one.
    const result = await resolveSandboxPath('.env', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.11: URL-encoded traversal (%2e%2e%2f) is refused', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('src/%2e%2e%2f%2e%2e%2fetc/passwd', ws.root)
    assert.equal(result.ok, false)
  })
})

test('T7.12: an empty path / null / non-string is refused without throwing', async () => {
  await withTmpWorkspace(async (ws) => {
    assert.equal((await resolveSandboxPath('', ws.root)).ok, false)
    assert.equal((await resolveSandboxPath(null, ws.root)).ok, false)
    assert.equal((await resolveSandboxPath(42, ws.root)).ok, false)
    assert.equal((await resolveSandboxPath(undefined, ws.root)).ok, false)
  })
})

test('T7.13: Windows separators (\'..\\\\..\\\\x\') are refused', async () => {
  await withTmpWorkspace(async (ws) => {
    const result = await resolveSandboxPath('..\\..\\x', ws.root)
    assert.equal(result.ok, false)
  })
})
