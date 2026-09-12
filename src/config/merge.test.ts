import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig, isLanguageExplicit } from './merge.ts'
import { DEFAULTS, DEFAULT_EXCLUDE } from './defaults.ts'
import { ConfigError } from '../util/errors.ts'
import { logger } from '../util/logger.ts'
import type { RawInputs } from './inputs.ts'
import type { FileConfig } from './schema.ts'

function baseInputs (overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    github_token: 'gh-token-abcdefgh',
    api_key: 'api-key-abcdefgh',
    api_base_url: '',
    model: 'input-model-name',
    api_headers: {},
    allow_insecure_base_url: false,
    config_path: '.github/code-review.yml',
    include: [],
    exclude: [],
    skip_labels: [],
    total_timeout_ms: 900000,
    ...overrides
  }
}

function baseFile (overrides: FileConfig = {}): FileConfig {
  return { ...overrides }
}

function asConfigError (err: unknown): ConfigError {
  if (!(err instanceof ConfigError)) throw new Error(`expected a ConfigError, got ${String(err)}`)
  return err
}

test('T1.31: a scalar set in both inputs and file -> input wins (FR-6)', () => {
  const resolved = mergeConfig(
    baseInputs({ language: 'en' }),
    baseFile({ review: { language: 'ru' } })
  )
  assert.equal(resolved.review.language, 'en')
})

test('T1.32: a scalar set only in the file -> taken from the file', () => {
  const resolved = mergeConfig(baseInputs(), baseFile({ mode: 'agent' }))
  assert.equal(resolved.mode, 'agent')
})

test('T1.33: a scalar set nowhere -> the default', () => {
  const resolved = mergeConfig(baseInputs(), baseFile())
  assert.equal(resolved.mode, DEFAULTS.mode)
  assert.equal(resolved.review.language, DEFAULTS.language)
})

test('T1.34: input omitted (empty) while the file sets a value -> the file wins', () => {
  const resolved = mergeConfig(baseInputs(), baseFile({ review: { max_comments: 99 } }))
  assert.equal(resolved.review.max_comments, 99)
})

test('T1.35: filters.exclude is the union of defaults + file + input, without duplicates', () => {
  const resolved = mergeConfig(
    baseInputs({ exclude: ['**/*.foo', '**/package-lock.json'] }),
    baseFile({ filters: { exclude: ['**/*.snap'] } })
  )
  assert.ok(resolved.filters.exclude.includes('**/*.foo'))
  assert.ok(resolved.filters.exclude.includes('**/*.snap'))
  for (const pattern of DEFAULT_EXCLUDE) {
    assert.ok(resolved.filters.exclude.includes(pattern))
  }
  const occurrences = resolved.filters.exclude.filter((p) => p === '**/package-lock.json')
  assert.equal(occurrences.length, 1, 'no duplicates')
})

test('T1.36: filters.include set in both file and input -> input REPLACES the file (not union)', () => {
  const resolved = mergeConfig(
    baseInputs({ include: ['input/**'] }),
    baseFile({ filters: { include: ['file/**'] } })
  )
  assert.deepEqual(resolved.filters.include, ['input/**'])
})

test('T1.37: api.headers in the file + api_headers input with different keys -> union', () => {
  const resolved = mergeConfig(
    baseInputs({ api_headers: { 'X-Input': 'i' } }),
    baseFile({ api: { headers: { 'X-File': 'f' } } })
  )
  assert.deepEqual(resolved.api.headers, { 'X-File': 'f', 'X-Input': 'i' })
})

test('T1.38: api.headers and api_headers with the same key -> input wins', () => {
  const resolved = mergeConfig(
    baseInputs({ api_headers: { 'X-Same': 'input-value' } }),
    baseFile({ api: { headers: { 'X-Same': 'file-value' } } })
  )
  assert.equal(resolved.api.headers['X-Same'], 'input-value')
})

test('T1.39: review.path_instructions comes only from the file and is present in the result', () => {
  const resolved = mergeConfig(
    baseInputs(),
    baseFile({ review: { path_instructions: [{ path: 'src/**', instructions: 'do x' }] } })
  )
  assert.deepEqual(resolved.review.path_instructions, [{ path: 'src/**', instructions: 'do x' }])
})

test('T1.40: the merge result validates against the final zod schema (ResolvedConfig)', () => {
  const resolved = mergeConfig(
    baseInputs({ api_base_url: 'https://api.example.com/v1' }),
    baseFile({
      review: { path_instructions: [{ path: 'src/**', instructions: 'x' }] },
      agent: { token_budget: 300000 }
    })
  )
  assert.equal(resolved.version, 1)
  assert.equal(resolved.agent.token_budget, 300000)
  assert.ok(Array.isArray(resolved.filters.exclude))
})

test('T1.23 (merge): api_base_url = http://example.com/v1, allow_insecure_base_url: false -> error requiring https', () => {
  assert.throws(
    () => mergeConfig(baseInputs({ api_base_url: 'http://example.com/v1' }), baseFile()),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.match(err.message, /https/i)
      return true
    }
  )
})

test('T1.24 (merge): api_base_url = http://localhost:11434/v1 -> OK (loopback exception)', () => {
  const resolved = mergeConfig(
    baseInputs({ api_base_url: 'http://localhost:11434/v1' }),
    baseFile()
  )
  assert.equal(resolved.api.base_url, 'http://localhost:11434/v1')
})

test('T1.54 (merge): http://vllm.internal.corp/v1 + allow_insecure_base_url: true -> OK, with a warning logged', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const resolved = mergeConfig(
    baseInputs({ api_base_url: 'http://vllm.internal.corp/v1', allow_insecure_base_url: true }),
    baseFile()
  )
  assert.equal(resolved.api.base_url, 'http://vllm.internal.corp/v1')
  assert.ok(warning.mock.calls.length >= 1)
})

test('T1.61 (merge): api.base_url set in the FILE (http), allow_insecure_base_url not set -> FR-10a error', () => {
  assert.throws(
    () =>
      mergeConfig(baseInputs(), baseFile({ api: { base_url: 'http://from-file.example.com/v1' } })),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.match(err.message, /https/i)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// TT.25-29: agent.web_search (THR-11) — off by default, its own call cap,
// and a merge-time warning (not an error) when enabled against a non-
// OpenRouter api_base_url.
// ---------------------------------------------------------------------------

test('TT.25: agent.web_search defaults to {enabled:false, max_calls:4}', () => {
  const resolved = mergeConfig(baseInputs(), baseFile())
  assert.deepEqual(resolved.agent.web_search, { enabled: false, max_calls: 4 })
})

test('TT.26: agent_web_search/agent_web_search_max_calls inputs win over the file', () => {
  const resolved = mergeConfig(
    baseInputs({
      api_base_url: 'https://openrouter.ai/api/v1',
      agent_web_search: true,
      agent_web_search_max_calls: 7
    }),
    baseFile({ agent: { web_search: { enabled: false, max_calls: 2 } } })
  )
  assert.deepEqual(resolved.agent.web_search, { enabled: true, max_calls: 7 })
})

test('TT.27: agent.web_search.enabled set only in the file is honored when the input is unset', () => {
  const resolved = mergeConfig(
    baseInputs({ api_base_url: 'https://openrouter.ai/api/v1' }),
    baseFile({ agent: { web_search: { enabled: true } } })
  )
  assert.equal(resolved.agent.web_search.enabled, true)
  assert.equal(resolved.agent.web_search.max_calls, 4)
})

test('TT.28: agent_web_search: true against a non-OpenRouter api_base_url warns but does not throw', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const resolved = mergeConfig(
    baseInputs({ api_base_url: 'https://api.openai.com/v1', agent_web_search: true }),
    baseFile()
  )
  assert.equal(resolved.agent.web_search.enabled, true)
  assert.ok(warning.mock.calls.some((c) => /openrouter/i.test(String(c.arguments[0]))))
})

test('TT.29: agent_web_search: true against api_base_url = openrouter.ai -> no warning', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  mergeConfig(
    baseInputs({ api_base_url: 'https://openrouter.ai/api/v1', agent_web_search: true }),
    baseFile()
  )
  assert.equal(warning.mock.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Дополнение G: agent.filter_model (noise filtering, opt-in, default '').
// ---------------------------------------------------------------------------

test('TV.1: agent_filter_model set nowhere -> empty string default (feature off)', () => {
  const resolved = mergeConfig(baseInputs(), baseFile())
  assert.equal(resolved.agent.filter_model, '')
})

test('TV.2: agent_filter_model input wins over the file (FR-6)', () => {
  const resolved = mergeConfig(
    baseInputs({ agent_filter_model: 'gpt-5-nano' }),
    baseFile({ agent: { filter_model: 'from-file-model' } })
  )
  assert.equal(resolved.agent.filter_model, 'gpt-5-nano')
})

test('TV.3: agent_filter_model set only in the file is honored when the input is unset', () => {
  const resolved = mergeConfig(baseInputs(), baseFile({ agent: { filter_model: 'from-file-model' } }))
  assert.equal(resolved.agent.filter_model, 'from-file-model')
})

// ---------------------------------------------------------------------------
// Дополнение B: isLanguageExplicit (PR-title language auto-detect).
// ---------------------------------------------------------------------------

test('TB.10: isLanguageExplicit - inputs.language set -> true', () => {
  assert.equal(isLanguageExplicit(baseInputs({ language: 'fr' }), baseFile()), true)
})

test('TB.11: isLanguageExplicit - only file review.language set -> true', () => {
  assert.equal(isLanguageExplicit(baseInputs(), baseFile({ review: { language: 'fr' } })), true)
})

test('TB.12: isLanguageExplicit - language set nowhere -> false', () => {
  assert.equal(isLanguageExplicit(baseInputs(), baseFile()), false)
})

// ---------------------------------------------------------------------------
// Дополнение E: review.custom_instructions.
// ---------------------------------------------------------------------------

test('TJ.4: custom_instructions longer than 4000 chars is truncated, with a warning logged', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  const long = 'x'.repeat(5000)
  const resolved = mergeConfig(baseInputs({ custom_instructions: long }), baseFile())
  assert.equal(resolved.review.custom_instructions.length, 4000)
  assert.ok(warning.mock.calls.length >= 1)
})

test('TJ.5: custom_instructions set in both input and file -> input wins (FR-6)', () => {
  const resolved = mergeConfig(
    baseInputs({ custom_instructions: 'from input' }),
    baseFile({ review: { custom_instructions: 'from file' } })
  )
  assert.equal(resolved.review.custom_instructions, 'from input')
})

test('custom_instructions set only in the file -> taken from the file', () => {
  const resolved = mergeConfig(baseInputs(), baseFile({ review: { custom_instructions: 'from file' } }))
  assert.equal(resolved.review.custom_instructions, 'from file')
})

test('custom_instructions set nowhere -> empty string default', () => {
  const resolved = mergeConfig(baseInputs(), baseFile())
  assert.equal(resolved.review.custom_instructions, '')
})

test('TW.19: the default tool-call ceiling is not the tightest agent budget — a model batching a ' +
  'handful of calls per turn must be able to use the whole default iteration budget', () => {
  // The traced production run (x-ai/grok-4.6, 84-file PR) averaged ~4.3 tool calls per iteration
  // and hit the tool-call ceiling at iteration 23 of 60, with every other budget still wide open.
  // A ceiling below `max_iterations * 5` makes the tool-call limit, not the iteration limit, the
  // one users actually run into — and it is the least legible of the five in a sticky comment.
  assert.ok(
    DEFAULTS.agent_max_tool_calls >= DEFAULTS.agent_max_iterations * 5,
    `agent_max_tool_calls (${DEFAULTS.agent_max_tool_calls}) binds before agent_max_iterations ` +
      `(${DEFAULTS.agent_max_iterations})`
  )
})
