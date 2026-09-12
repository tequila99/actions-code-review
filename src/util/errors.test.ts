import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, ProviderError, GithubApiError, AppError } from './errors.ts'
import { registerSecret } from './secrets.ts'

test('T1.60: ConfigError is a typed error with a hint, mapped to a redacted user message', () => {
  registerSecret('leakedTokenValueXYZ')
  const err = new ConfigError(
    'Config file contains a forbidden key with value leakedTokenValueXYZ',
    'Use the `api_key` input instead of putting secrets in the config file.'
  )
  assert.ok(err instanceof Error)
  assert.ok(err instanceof AppError)
  assert.equal(err.name, 'ConfigError')
  assert.equal(err.code, 'CONFIG_ERROR')

  const msg = err.toUserMessage()
  assert.ok(msg.includes('Use the `api_key` input instead'), 'hint must be present')
  assert.ok(!msg.includes('leakedTokenValueXYZ'), 'secret must be redacted')
  assert.ok(msg.includes('***'), 'redaction marker must be present')
})

test('T1.60b: ProviderError is a typed error with a hint, mapped to a redacted user message', () => {
  registerSecret('providerSecretTokenABC')
  const err = new ProviderError(
    '401 Unauthorized from provider, key=providerSecretTokenABC',
    'Check that `api_key` is valid for this provider.'
  )
  assert.ok(err instanceof AppError)
  assert.equal(err.code, 'PROVIDER_ERROR')

  const msg = err.toUserMessage()
  assert.ok(msg.includes('Check that `api_key` is valid'), 'hint must be present')
  assert.ok(!msg.includes('providerSecretTokenABC'), 'secret must be redacted')
})

test('T1.60c: ConfigError without a hint still redacts the message', () => {
  registerSecret('noHintSecretValue1')
  const err = new ConfigError('boom noHintSecretValue1')
  const msg = err.toUserMessage()
  assert.ok(!msg.includes('noHintSecretValue1'))
})

test('T2.0: GithubApiError is a typed error with a hint, mapped to a redacted user message', () => {
  registerSecret('ghApiSecretTokenXYZ')
  const err = new GithubApiError(
    'GitHub API rejected the request, token=ghApiSecretTokenXYZ',
    'Check that `github_token` has the required permissions.'
  )
  assert.ok(err instanceof AppError)
  assert.equal(err.name, 'GithubApiError')
  assert.equal(err.code, 'GITHUB_API_ERROR')

  const msg = err.toUserMessage()
  assert.ok(msg.includes('Check that `github_token`'), 'hint must be present')
  assert.ok(!msg.includes('ghApiSecretTokenXYZ'), 'secret must be redacted')
})
