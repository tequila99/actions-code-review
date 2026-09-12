import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderAdapter } from './factory.ts'
import { AnthropicAdapter } from './anthropic.ts'
import { OpenAICompatibleAdapter } from './openai-compatible.ts'
import { ProviderError } from '../util/errors.ts'
import type { ResolvedConfig } from '../config/schema.ts'

function baseConfig (overrides: Partial<ResolvedConfig['api']> = {}): ResolvedConfig {
  return {
    version: 1,
    mode: 'diff',
    model: 'gpt-4o-mini',
    github_token: 'gh-token',
    config_path: '.github/code-review.yml',
    api: {
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      flavor: 'openai',
      context_window: 128000,
      request_timeout_ms: 120000,
      total_timeout_ms: 900000,
      headers: {},
      allow_insecure_base_url: false,
      ...overrides
    },
    filters: {
      include: [],
      exclude: [],
      max_files: 50,
      max_diff_bytes: 400000,
      skip_drafts: false,
      skip_labels: [],
      context_lines: 3
    },
    review: {
      language: 'en',
      max_comments: 25,
      max_output_tokens: 4000,
      max_model_calls: 3,
      fail_on_severity: 'none',
      summary_only: false,
      custom_instructions: '',
      focus: [],
      ignore: [],
      path_instructions: []
    },
    context: { always: [], layers: [], max_context_bytes: 60000 },
    agent: {
      max_iterations: 20,
      max_tool_calls: 60,
      token_budget: 300000,
      tool_output_max_bytes: 32768,
      allow_suggestions: true,
      tools: [],
      web_search: { enabled: false, max_calls: 4 },
      filter_model: ''
    },
    budget: {},
    incremental: true,
    auto_threshold_files: 30,
    dry_run: false,
    debug: false
  }
}

test('T3.48: flavor "openai" produces an OpenAICompatibleAdapter instance', () => {
  const adapter = createProviderAdapter(baseConfig({ flavor: 'openai' }))
  assert.ok(adapter instanceof OpenAICompatibleAdapter)
  assert.equal(adapter.flavor, 'openai')
})

test('T9.9a (стадия 9a): flavor "anthropic" produces an AnthropicAdapter instance', () => {
  const adapter = createProviderAdapter(baseConfig({ flavor: 'anthropic' }))
  assert.ok(adapter instanceof AnthropicAdapter)
  assert.equal(adapter.flavor, 'anthropic')
})

test('T3.49b: flavor "gemini" still gives a clear "not supported yet" error before stage 9b', () => {
  assert.throws(
    () => createProviderAdapter(baseConfig({ flavor: 'gemini' })),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.message, /gemini/i)
      assert.match(err.message, /not supported yet/i)
      return true
    }
  )
})

test('T3.50: an unknown flavor gives an error listing the allowed values', () => {
  const config = baseConfig()
  // @ts-expect-error deliberately invalid flavor to exercise the runtime guard
  config.api.flavor = 'bogus'
  assert.throws(
    () => createProviderAdapter(config),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError)
      const fullText = err.toUserMessage()
      assert.match(fullText, /bogus/)
      assert.match(fullText, /openai/)
      assert.match(fullText, /anthropic/)
      assert.match(fullText, /gemini/)
      return true
    }
  )
})
