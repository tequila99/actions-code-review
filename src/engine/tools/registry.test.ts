import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolRegistry } from './registry.ts'

const ALL_NAMES = ['read_file', 'list_files', 'grep', 'get_diff', 'post_comment']

// T7.45/T7.48 are exercised end-to-end in agent-engine.test.ts (the config
// -> AgentEngine -> provider.complete() `tools` array path); these are the
// unit-level equivalents for `buildToolRegistry` itself.

test('an empty allowlist enables every tool', () => {
  const registry = buildToolRegistry([])
  assert.deepEqual(registry.specs.map((s) => s.name).sort(), [...ALL_NAMES].sort())
  for (const name of ALL_NAMES) assert.ok(registry.handlers.has(name))
})

test('a non-empty allowlist narrows the set passed to the model', () => {
  const registry = buildToolRegistry(['read_file', 'get_diff'])
  assert.deepEqual(registry.specs.map((s) => s.name).sort(), ['get_diff', 'read_file'])
  assert.equal(registry.handlers.size, 2)
  assert.ok(registry.handlers.has('read_file'))
  assert.ok(registry.handlers.has('get_diff'))
  assert.equal(registry.handlers.has('grep'), false)
})

test('TI.4c: buildToolRegistry threads allowSuggestions through to post_comment\'s spec (default true)', () => {
  const registry = buildToolRegistry([])
  const postCommentSpec = registry.specs.find((s) => s.name === 'post_comment')!
  const properties = postCommentSpec.parameters.properties as Record<string, unknown>
  assert.ok('suggestion' in properties)
})

test('TI.4d: buildToolRegistry(enabledTools, false) strips suggestion fields from post_comment\'s spec', () => {
  const registry = buildToolRegistry([], false)
  const postCommentSpec = registry.specs.find((s) => s.name === 'post_comment')!
  const properties = postCommentSpec.parameters.properties as Record<string, unknown>
  assert.equal('suggestion' in properties, false)
})

test('there is no write/exec/network tool in the registry (THR-9/SEC-4)', () => {
  const registry = buildToolRegistry([])
  const names = registry.specs.map((s) => s.name)
  for (const forbidden of ['write_file', 'bash', 'run', 'exec', 'fetch', 'http_request', 'shell']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be a registered tool`)
  }
  assert.deepEqual(names.sort(), [...ALL_NAMES].sort())
})

test('TT.30: web_search is absent by default, even with an empty (allow-all) allowlist', () => {
  const registry = buildToolRegistry([])
  assert.equal(registry.specs.some((s) => s.name === 'web_search'), false)
  assert.equal(registry.handlers.has('web_search'), false)
})

test('TT.31: webSearchEnabled=true adds web_search to an allow-all registry', () => {
  const registry = buildToolRegistry([], true, true)
  assert.ok(registry.specs.some((s) => s.name === 'web_search'))
  assert.ok(registry.handlers.has('web_search'))
  assert.deepEqual(registry.specs.map((s) => s.name).sort(), [...ALL_NAMES, 'web_search'].sort())
})

test('TT.32: an explicit ["web_search"] allowlist narrows to just it, only when enabled', () => {
  const enabled = buildToolRegistry(['web_search'], true, true)
  assert.deepEqual(enabled.specs.map((s) => s.name), ['web_search'])

  const disabled = buildToolRegistry(['web_search'], true, false)
  assert.deepEqual(disabled.specs, [])
  assert.equal(disabled.handlers.size, 0)
})

test('TT.33: web_search stays out of the forbidden-network-tool check\'s set even when enabled (THR-9/SEC-4/THR-11)', () => {
  const registry = buildToolRegistry([], true, true)
  const names = registry.specs.map((s) => s.name)
  for (const forbidden of ['write_file', 'bash', 'run', 'exec', 'http_request', 'shell']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be a registered tool`)
  }
  assert.deepEqual(names.sort(), [...ALL_NAMES, 'web_search'].sort())
})
