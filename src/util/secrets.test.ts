import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSecret, redact } from './secrets.ts'

test('T1.49: registerSecret(v) then redact replaces the secret with ***', () => {
  registerSecret('sup3rSecretValueAAA')
  assert.equal(redact('key=sup3rSecretValueAAA'), 'key=***')
})

test('T1.50: redact replaces multiple registered secrets', () => {
  registerSecret('firstSecretValueBBB')
  registerSecret('secondSecretValueCCC')
  const text = 'a=firstSecretValueBBB b=secondSecretValueCCC'
  assert.equal(redact(text), 'a=*** b=***')
})

test('T1.51: registerSecret("") and registerSecret(undefined) are ignored and redact does not corrupt unrelated text', () => {
  registerSecret('')
  registerSecret(undefined)
  const text = 'nothing secret in this line at all'
  assert.equal(redact(text), text)
})

test('T1.52: registerSecret ignores values shorter than 4 characters', () => {
  registerSecret('abc')
  const text = 'the string abc should stay exactly as abc'
  assert.equal(redact(text), text)
})

test('T1.53: redact does not change text that contains no secrets', () => {
  const text = 'a perfectly ordinary log line'
  assert.equal(redact(text), text)
})
