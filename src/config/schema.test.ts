import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError } from '../util/errors.ts'
import { parseFileConfig, parseResolvedConfig, findSecretKeyPath, normalizeKeyName } from './schema.ts'
import { makeResolvedConfig } from '../../test/helpers/resolved-config.ts'

/** Full example straight from PRD §9 (raw, already-YAML-parsed shape). */
const FULL_PRD_EXAMPLE = {
  version: 1,
  mode: 'diff',
  model: 'qwen/qwen3-coder',
  api: {
    base_url: 'https://openrouter.ai/api/v1',
    flavor: 'openai',
    context_window: 262144,
    request_timeout_ms: 120000,
    total_timeout_ms: 900000,
    headers: {
      'X-Title': 'tequila99 Code Review',
      'HTTP-Referer': 'https://github.com/tequila99'
    }
  },
  filters: {
    include: ['src/**', 'apps/**'],
    exclude: ['**/*.snap', '**/__generated__/**'],
    max_files: 50,
    max_diff_bytes: 400000,
    skip_drafts: true,
    skip_labels: ['no-ai-review', 'wip'],
    context_lines: 3
  },
  review: {
    language: 'ru',
    max_comments: 25,
    fail_on_severity: 'none',
    summary_only: false,
    focus: ['correctness', 'security', 'performance', 'readability', 'architecture'],
    ignore: [
      'форматирование, если проходит prettier',
      'предпочтения по именованию без функционального влияния'
    ],
    path_instructions: [
      {
        path: 'src/db/**',
        instructions:
          'Проверяй инварианты миграций: миграция должна быть обратимой, новые колонки — nullable или с DEFAULT.\n'
      },
      {
        path: 'apps/web/**',
        instructions:
          'Проверяй паттерны пагинации и бесконечного скролла, отсутствие ручных импортов там, где работают auto-imports.\n'
      },
      {
        path: 'packages/common/**',
        instructions: 'Изменение публичного API требует версии в package.json.\n'
      }
    ]
  },
  context: {
    always: ['CLAUDE.md'],
    layers: [
      { path: 'src/db/**', context_files: ['.claude/context/db.md'] },
      { path: 'apps/web/**', context_files: ['.claude/context/frontend.md'] }
    ],
    max_context_bytes: 60000
  },
  agent: {
    max_iterations: 20,
    max_tool_calls: 60,
    token_budget: 300000,
    tool_output_max_bytes: 32768,
    tools: ['get_diff', 'read_file', 'list_files', 'grep', 'post_comment', 'finish']
  },
  budget: {
    max_cost_usd: 0.5,
    pricing: {
      input_per_1m: 0.3,
      output_per_1m: 1.0
    }
  }
}

test('T1.1: the full example config from PRD §9 parses without error', () => {
  const parsed = parseFileConfig(FULL_PRD_EXAMPLE)
  assert.equal(parsed.model, 'qwen/qwen3-coder')
  assert.equal(parsed.api?.base_url, 'https://openrouter.ai/api/v1')
  assert.equal(parsed.filters?.max_files, 50)
  assert.equal(parsed.agent?.token_budget, 300000)
  assert.equal(parsed.review?.path_instructions?.length, 3)
})

test('T1.2: an empty object {} is valid (everything is optional)', () => {
  assert.doesNotThrow(() => parseFileConfig({}))
})

function asConfigError (err: unknown): ConfigError {
  if (!(err instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, got ${String(err)}`)
  }
  return err
}

test('T1.3: mode: "wrong" fails with a message listing diff/agent/auto', () => {
  assert.throws(
    () => parseFileConfig({ mode: 'wrong' }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(err.message.includes('mode'))
      assert.ok(err.message.includes('diff'))
      assert.ok(err.message.includes('agent'))
      assert.ok(err.message.includes('auto'))
      return true
    }
  )
})

test('T1.4: filters.max_files: -1 fails, must be >= 1', () => {
  assert.throws(
    () => parseFileConfig({ filters: { max_files: -1 } }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(err.message.includes('filters.max_files'))
      return true
    }
  )
})

test('T1.5: filters.context_lines: 50 fails, must be within 0..30', () => {
  assert.throws(
    () => parseFileConfig({ filters: { context_lines: 50 } }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(err.message.includes('filters.context_lines'))
      assert.ok(err.message.includes('0 and 30'), `expected the 0..30 bound in: ${err.message}`)
      return true
    }
  )
})

test('TE.4: filters.context_lines: 15 is valid (raised cap, was rejected at >10 before)', () => {
  const config = parseFileConfig({ filters: { context_lines: 15 } })
  assert.equal(config.filters?.context_lines, 15)
})

test('T1.6: api.api_key in the YAML config fails with a message about forbidden secrets', () => {
  assert.throws(
    () => parseFileConfig({ api: { api_key: 'sk-xxx' } }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(/secret/i.test(err.message + (err.hint ?? '')))
      assert.ok(err.message.includes('api.api_key') || err.message.includes('api_key'))
      return true
    }
  )
})

test('T1.7: token/secret/password/authorization as exact key names at any nesting level fail', () => {
  const cases: unknown[] = [
    { api: { token: 'x' } },
    { review: { nested: { secret: 'x' } } },
    { filters: { password: 'x' } },
    { context: { deep: { deeper: { authorization: 'x' } } } }
  ]
  for (const raw of cases) {
    assert.throws(
      () => parseFileConfig(raw),
      ConfigError,
      `expected rejection for ${JSON.stringify(raw)}`
    )
  }
})

test('T1.8: review.path_instructions without "path" fails at review.path_instructions.0.path', () => {
  assert.throws(
    () => parseFileConfig({ review: { path_instructions: [{ instructions: 'do things' }] } }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(err.message.includes('review.path_instructions.0.path'))
      return true
    }
  )
})

test('T1.9: version: 2 (unknown version) fails with a hint about supported versions', () => {
  assert.throws(
    () => parseFileConfig({ version: 2 }),
    (thrown: unknown) => {
      const err = asConfigError(thrown)
      assert.ok(err.message.includes('version'))
      assert.ok(/supported/i.test(err.message))
      return true
    }
  )
})

test('T1.10: error messages contain the full field path', () => {
  try {
    parseFileConfig({ filters: { max_files: -1 } })
    assert.fail('expected parseFileConfig to throw')
  } catch (thrown) {
    const err = asConfigError(thrown)
    assert.ok(err.message.includes('filters.max_files:'))
  }
})

test('T1.56: agent.token_budget and a top-level agent_token_budget-like key are valid (exact-match deny-list, not substring)', () => {
  assert.doesNotThrow(() => parseFileConfig({ agent: { token_budget: 300000 } }))
  // "agent_token_budget" normalizes to itself, not to "token" -> must not trip the deny-list.
  assert.equal(findSecretKeyPath({ agent_token_budget: 300000 }), null)
  assert.equal(findSecretKeyPath({ github_token_permissions: 'read' }), null)
  assert.equal(normalizeKeyName('API-KEY'), 'api_key')
})

test('TT.22: agent.web_search.{enabled,max_calls} parses in the file schema', () => {
  const file = parseFileConfig({ agent: { web_search: { enabled: true, max_calls: 2 } } })
  assert.deepEqual(file.agent?.web_search, { enabled: true, max_calls: 2 })
})

test('TT.23: parseResolvedConfig rejects a resolved shape missing agent.web_search', () => {
  const resolved = makeResolvedConfig()
  const { web_search: _webSearch, ...agentWithoutWebSearch } = resolved.agent
  const raw = { ...resolved, agent: agentWithoutWebSearch }
  assert.throws(() => parseResolvedConfig(raw))
})
