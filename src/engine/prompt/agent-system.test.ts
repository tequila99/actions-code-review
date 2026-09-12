import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from './agent-system.ts'
import { buildToolRegistry } from '../tools/registry.ts'
import { UNTRUSTED_CONTENT_INSTRUCTION } from './system.ts'
import { makeResolvedConfig } from '../../../test/helpers/resolved-config.ts'

test('T7.56: the system prompt describes every active tool, matching the registry', () => {
  const registry = buildToolRegistry([])
  const config = makeResolvedConfig()
  const prompt = buildAgentSystemPrompt(config, registry.specs)
  for (const tool of registry.specs) {
    assert.ok(prompt.includes(tool.name), `prompt should mention tool "${tool.name}"`)
    assert.ok(prompt.includes(tool.description), `prompt should include the description of "${tool.name}"`)
  }
})

test('T7.57: the system prompt applies the SEC-1 untrusted-content wrapping instruction', () => {
  const config = makeResolvedConfig()
  const prompt = buildAgentSystemPrompt(config, [])
  assert.match(prompt, /<untrusted_content>/)
  assert.match(prompt, /never instructions/i)
})

test('TN.6: the system prompt warns against repeating identical tool calls and overly broad searches', () => {
  const config = makeResolvedConfig()
  const prompt = buildAgentSystemPrompt(config, [])
  assert.match(prompt, /scale/i)
  assert.match(prompt, /repeating|repeat/i)
  assert.match(prompt, /broad/i)
})

test('TP.1: the system prompt tells the model to post_comment findings as soon as it identifies them, not only at the end', () => {
  const config = makeResolvedConfig()
  const prompt = buildAgentSystemPrompt(config, [])
  assert.match(prompt, /as soon as/i)
  assert.match(prompt, /do not wait|don't wait/i)
})

test('T7.58: the system prompt contains path_instructions and the configured language', () => {
  const config = makeResolvedConfig({
    review: {
      language: 'ru',
      path_instructions: [{ path: 'src/payments/**', instructions: 'Watch currency rounding.' }]
    }
  })
  const prompt = buildAgentSystemPrompt(config, [])
  assert.match(prompt, /"ru"/)
  assert.match(prompt, /src\/payments\/\*\*/)
  assert.match(prompt, /Watch currency rounding\./)
})

test('TT.1: the system prompt tells the model dependency source (node_modules) is unavailable and not to search for it', () => {
  const config = makeResolvedConfig()
  const prompt = buildAgentSystemPrompt(config, [])
  assert.match(prompt, /node_modules/)
  assert.match(prompt, /not present|does not include/i)
  assert.match(prompt, /trained knowledge|own knowledge/i)
})

test('TJ.3: review.custom_instructions appears in the agent prompt, after focus/ignore/path_instructions and before UNTRUSTED_CONTENT_INSTRUCTION', () => {
  const config = makeResolvedConfig({
    review: {
      focus: ['SQL injection'],
      ignore: ['formatting'],
      path_instructions: [{ path: 'src/**', instructions: 'Be careful.' }],
      custom_instructions: 'Prefer terse review comments, one sentence each.'
    }
  })
  const prompt = buildAgentSystemPrompt(config, [])
  const customIdx = prompt.indexOf('Prefer terse review comments')
  assert.ok(customIdx > -1)
  assert.ok(prompt.indexOf('SQL injection') < customIdx)
  assert.ok(prompt.indexOf('formatting') < customIdx)
  assert.ok(prompt.indexOf('Be careful.') < customIdx)
  assert.ok(customIdx < prompt.indexOf(UNTRUSTED_CONTENT_INSTRUCTION))
})
