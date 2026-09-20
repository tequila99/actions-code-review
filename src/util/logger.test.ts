import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logger, internals, debugLog, truncateForLog } from './logger.ts'
import { registerSecret } from './secrets.ts'

test('T1.57: every log level passes the message through redact() before output', (t) => {
  registerSecret('loggerSecretValue123')
  const info = t.mock.method(internals, 'info', () => {})
  const warning = t.mock.method(internals, 'warning', () => {})
  const debug = t.mock.method(internals, 'debug', () => {})
  const error = t.mock.method(internals, 'error', () => {})

  logger.info('info message loggerSecretValue123')
  logger.warning('warning message loggerSecretValue123')
  logger.debug('debug message loggerSecretValue123')
  logger.error('error message loggerSecretValue123')

  for (const spy of [info, warning, debug, error]) {
    assert.equal(spy.mock.calls.length, 1)
    const [message] = spy.mock.calls[0]!.arguments
    assert.ok(!(message as string).includes('loggerSecretValue123'))
    assert.ok((message as string).includes('***'))
  }
})

test('T1.58: group() calls startGroup/endGroup, including when fn throws', (t) => {
  const startGroup = t.mock.method(internals, 'startGroup', () => {})
  const endGroup = t.mock.method(internals, 'endGroup', () => {})

  const result = logger.group('config', () => 42)
  assert.equal(result, 42)
  assert.equal(startGroup.mock.calls.length, 1)
  assert.equal(endGroup.mock.calls.length, 1)

  assert.throws(
    () =>
      logger.group('config', () => {
        throw new Error('boom from group fn')
      }),
    /boom from group fn/
  )
  assert.equal(startGroup.mock.calls.length, 2)
  assert.equal(endGroup.mock.calls.length, 2, 'endGroup must run even when fn throws')
})

test('T1.58b: group() calls endGroup after an async fn settles, including on rejection', async (t) => {
  const startGroup = t.mock.method(internals, 'startGroup', () => {})
  const endGroup = t.mock.method(internals, 'endGroup', () => {})

  const value = await logger.group('async-ok', async () => 'done')
  assert.equal(value, 'done')
  assert.equal(startGroup.mock.calls.length, 1)
  assert.equal(endGroup.mock.calls.length, 1)

  await assert.rejects(
    () =>
      logger.group('async-fail', async () => {
        throw new Error('async boom')
      }),
    /async boom/
  )
  assert.equal(endGroup.mock.calls.length, 2)
})

test('T1.59: logging a URL with userinfo and a query string strips both before output', (t) => {
  const info = t.mock.method(internals, 'info', () => {})
  logger.info('fetching https://user:pass@host/v1?key=abc now')
  const [message] = info.mock.calls[0]!.arguments as [string]
  assert.ok(!message.includes('user:pass@'), 'userinfo must be stripped')
  assert.ok(!message.includes('key=abc'), 'query string must be stripped')
  assert.ok(!message.includes('?'), 'no leftover query separator')
})

test('TL.1: debugLog(false, ...) never calls core.info; debugLog(true, ...) does, prefixed', (t) => {
  const info = t.mock.method(internals, 'info', () => {})
  debugLog(false, 'should not appear')
  assert.equal(info.mock.callCount(), 0)

  debugLog(true, 'iteration detail')
  assert.equal(info.mock.callCount(), 1)
  const [message] = info.mock.calls[0]!.arguments as [string]
  assert.match(message, /^\[debug]/)
  assert.match(message, /iteration detail/)
})

test('TL.2: debugLog(true, ...) still redacts registered secrets, same as logger.info', (t) => {
  registerSecret('debugLogSecretValue456')
  const info = t.mock.method(internals, 'info', () => {})
  debugLog(true, 'token was debugLogSecretValue456')
  const [message] = info.mock.calls[0]!.arguments as [string]
  assert.ok(!message.includes('debugLogSecretValue456'))
  assert.ok(message.includes('***'))
})

test('TL.3: truncateForLog leaves short text untouched and clips long text with a marker', () => {
  const short = 'a short line'
  assert.equal(truncateForLog(short), short)

  // The default must fit a typical reasoning-model response (issue #12).
  const medium = 'y'.repeat(15000)
  assert.equal(truncateForLog(medium), medium)

  const long = 'x'.repeat(30000)
  const clipped = truncateForLog(long)
  assert.ok(clipped.length < long.length)
  assert.ok(clipped.endsWith('…(truncated)'))

  const clippedCustom = truncateForLog('abcdef', 3)
  assert.equal(clippedCustom, 'abc…(truncated)')
})
