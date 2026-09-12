import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileConfig } from './file-config.ts'
import { ConfigError } from '../util/errors.ts'
import { withEnvAsync } from '../../test/helpers/env.ts'

const FIXTURES_DIR = path.join(process.cwd(), 'test/fixtures/config')

test('T1.26: a missing file returns {} without an error', async () => {
  await withEnvAsync({ GITHUB_WORKSPACE: FIXTURES_DIR }, async () => {
    const config = await readFileConfig('does-not-exist.yml')
    assert.deepEqual(config, {})
  })
})

test('T1.27: invalid YAML fails with an error naming the file', async () => {
  await withEnvAsync({ GITHUB_WORKSPACE: FIXTURES_DIR }, async () => {
    await assert.rejects(
      () => readFileConfig('invalid.yml'),
      (thrown: unknown) => {
        if (!(thrown instanceof ConfigError)) throw new Error('expected a ConfigError')
        assert.ok(thrown.message.includes('invalid.yml'))
        return true
      }
    )
  })
})

test('T1.28: the file is read from config_path, not the default path', async () => {
  await withEnvAsync({ GITHUB_WORKSPACE: FIXTURES_DIR }, async () => {
    const custom = await readFileConfig('custom-name.yml')
    assert.equal(custom.model, 'from-custom-path-file')

    const atDefault = await readFileConfig('.github/code-review.yml')
    assert.equal(atDefault.model, 'from-default-path-file')
  })
})

test('T1.29: an empty (0 byte) file returns {} without an error', async () => {
  await withEnvAsync({ GITHUB_WORKSPACE: FIXTURES_DIR }, async () => {
    const config = await readFileConfig('empty.yml')
    assert.deepEqual(config, {})
  })
})

test('T1.30: a file containing only comments returns {} without an error', async () => {
  await withEnvAsync({ GITHUB_WORKSPACE: FIXTURES_DIR }, async () => {
    const config = await readFileConfig('comments-only.yml')
    assert.deepEqual(config, {})
  })
})
