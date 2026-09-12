import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInputs } from './inputs.ts'
import { ConfigError } from '../util/errors.ts'
import { internals as secretsInternals } from '../util/secrets.ts'
import { logger } from '../util/logger.ts'
import { withEnv } from '../../test/helpers/env.ts'

/** `core.getInput('x')` reads `process.env.INPUT_X`. `undefined` clears the var. */
type InputEnv = Record<string, string | undefined>

function withInputs<T> (inputs: InputEnv, fn: () => T): T {
  // Always blank out the two secret-fallback env vars first: this suite must
  // never fall through to whatever GITHUB_TOKEN/CODE_REVIEW_API_KEY happen to
  // be set in the ambient shell (which would both make tests non-hermetic and
  // risk printing a real secret via `core.setSecret`'s `::add-mask::` command
  // during the T1.18 spy assertions). Tests that specifically exercise the
  // env fallback (T1.12/T1.14) set a fake value via a nested `withEnv`.
  const env: InputEnv = { GITHUB_TOKEN: undefined, CODE_REVIEW_API_KEY: undefined }
  for (const [key, value] of Object.entries(inputs)) {
    env[`INPUT_${key.toUpperCase()}`] = value
  }
  return withEnv(env, fn)
}

/** Most tests only care about a field other than `model`; keep it out of the way. */
function withModelAnd<T> (inputs: InputEnv, fn: () => T): T {
  return withInputs({ model: 'gpt-test-model', ...inputs }, fn)
}

test('T1.11: model not set fails with "input `model` is required"', () => {
  withInputs({}, () => {
    assert.throws(
      () => readInputs(),
      (thrown: unknown) => {
        if (!(thrown instanceof ConfigError)) throw new Error('expected ConfigError')
        assert.match(thrown.message, /model/i)
        assert.match(thrown.message, /required/i)
        return true
      }
    )
  })
})

test('T1.12: api_key empty, CODE_REVIEW_API_KEY set -> taken from env', () => {
  withModelAnd({ api_key: '' }, () => {
    withEnv({ CODE_REVIEW_API_KEY: 'env-api-key-value' }, () => {
      const inputs = readInputs()
      assert.equal(inputs.api_key, 'env-api-key-value')
    })
  })
})

test('T1.13: api_key set both in input and env -> input wins', () => {
  withModelAnd({ api_key: 'input-api-key-value' }, () => {
    withEnv({ CODE_REVIEW_API_KEY: 'env-api-key-value' }, () => {
      const inputs = readInputs()
      assert.equal(inputs.api_key, 'input-api-key-value')
    })
  })
})

test('T1.14: github_token empty, GITHUB_TOKEN set -> taken from env', () => {
  withModelAnd({ github_token: '' }, () => {
    withEnv({ GITHUB_TOKEN: 'env-github-token-value' }, () => {
      const inputs = readInputs()
      assert.equal(inputs.github_token, 'env-github-token-value')
    })
  })
})

test("T1.15: api_headers = 'X-A: 1\\nX-B: 2' parses to {'X-A':'1','X-B':'2'}", () => {
  withModelAnd({ api_headers: 'X-A: 1\nX-B: 2' }, () => {
    const inputs = readInputs()
    assert.deepEqual(inputs.api_headers, { 'X-A': '1', 'X-B': '2' })
  })
})

test('T1.16: a line without ":" in api_headers is warned about and skipped, the rest still parse', (t) => {
  const warning = t.mock.method(logger, 'warning', () => {})
  withModelAnd({ api_headers: 'this-line-has-no-colon\nX-A: 1' }, () => {
    const inputs = readInputs()
    assert.deepEqual(inputs.api_headers, { 'X-A': '1' })
  })
  assert.ok(warning.mock.calls.length >= 1)
})

test('T1.17: an api_headers value containing ":" splits on the FIRST colon only', () => {
  withModelAnd({ api_headers: 'X-Url: https://a:8080' }, () => {
    const inputs = readInputs()
    assert.equal(inputs.api_headers['X-Url'], 'https://a:8080')
  })
})

test('T1.18: core.setSecret (via the secrets seam) is called for both github_token and api_key', (t) => {
  const setSecret = t.mock.method(secretsInternals, 'setSecret', () => {})
  withModelAnd({ github_token: 'gh-token-value-1234', api_key: 'api-key-value-5678' }, () => {
    readInputs()
  })
  const values = setSecret.mock.calls.map((c) => c.arguments[0])
  assert.ok(values.includes('gh-token-value-1234'))
  assert.ok(values.includes('api-key-value-5678'))
})

test('T1.19: api_headers values of auth-shaped header names are masked too', (t) => {
  const setSecret = t.mock.method(secretsInternals, 'setSecret', () => {})
  withModelAnd({ api_headers: 'X-Internal-Token: super-secret-header-value' }, () => {
    readInputs()
  })
  const values = setSecret.mock.calls.map((c) => c.arguments[0])
  assert.ok(values.includes('super-secret-header-value'))
})

// ---------------------------------------------------------------------------
// TX: parseApiHeaders only registers a header's value as a secret when the
// header NAME itself looks like a credential carrier — masking every header
// value regardless of its name (the old T1.19 behavior) corrupted unrelated
// output whenever a non-secret value happened to match, e.g. a tenant id.
// ---------------------------------------------------------------------------

test('TX.1: Authorization header value is masked', (t) => {
  const setSecret = t.mock.method(secretsInternals, 'setSecret', () => {})
  withModelAnd({ api_headers: 'Authorization: Bearer abc123' }, () => {
    readInputs()
  })
  const values = setSecret.mock.calls.map((c) => c.arguments[0])
  assert.ok(values.includes('Bearer abc123'))
})

test('TX.2: a non-auth-shaped header name (X-Tenant-Id) does not register its value as a secret', (t) => {
  const setSecret = t.mock.method(secretsInternals, 'setSecret', () => {})
  withModelAnd({ api_headers: 'X-Tenant-Id: platform' }, () => {
    readInputs()
  })
  const values = setSecret.mock.calls.map((c) => c.arguments[0])
  assert.ok(!values.includes('platform'))
})

test('T1.20: multiline include/exclude/skip_labels become arrays of trimmed, non-empty strings', () => {
  withModelAnd(
    {
      include: 'src/**\n\n  apps/**  \n',
      exclude: '**/*.snap\n',
      skip_labels: 'wip\nno-ai-review\n\n'
    },
    () => {
      const inputs = readInputs()
      assert.deepEqual(inputs.include, ['src/**', 'apps/**'])
      assert.deepEqual(inputs.exclude, ['**/*.snap'])
      assert.deepEqual(inputs.skip_labels, ['wip', 'no-ai-review'])
    }
  )
})

test("T1.21: temperature = '' -> the field is absent from the result (not NaN, not 0)", () => {
  withModelAnd({ temperature: '' }, () => {
    const inputs = readInputs()
    assert.equal('temperature' in inputs, false)
  })
})

test('T1.22: boolean input "true"/"false"/"" -> true/false/default', () => {
  withModelAnd({ dry_run: 'true' }, () => {
    assert.equal(readInputs().dry_run, true)
  })
  withModelAnd({ dry_run: 'false' }, () => {
    assert.equal(readInputs().dry_run, false)
  })
  withModelAnd({ dry_run: '' }, () => {
    assert.equal('dry_run' in readInputs(), false)
  })
})

test('T1.25: a trailing slash on api_base_url is normalized away', () => {
  withModelAnd({ api_base_url: 'https://example.com/v1/' }, () => {
    assert.equal(readInputs().api_base_url, 'https://example.com/v1')
  })
})

test('T1.55: total_timeout_ms is absent when unset (so a file value can win), or uses the provided value', () => {
  withModelAnd({}, () => {
    assert.equal('total_timeout_ms' in readInputs(), false)
  })
  withModelAnd({ total_timeout_ms: '60000' }, () => {
    assert.equal(readInputs().total_timeout_ms, 60000)
  })
})
