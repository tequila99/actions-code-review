import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkip, type SkipFiltersConfig } from './pull-request.ts'

function config (overrides: Partial<SkipFiltersConfig['filters']> = {}): SkipFiltersConfig {
  return { filters: { skip_drafts: true, skip_labels: [], ...overrides } }
}

test('T2.51: draft: true, skip_drafts: true -> shouldSkip returns "draft"', () => {
  assert.equal(shouldSkip({ draft: true, labels: [] }, config({ skip_drafts: true })), 'draft')
})

test('T2.52: draft: true, skip_drafts: false -> not skipped', () => {
  assert.equal(shouldSkip({ draft: true, labels: [] }, config({ skip_drafts: false })), null)
})

test('T2.53: a label from skip_labels present on the PR -> shouldSkip returns "label"', () => {
  const cfg = config({ skip_drafts: false, skip_labels: ['no-review', 'wip'] })
  assert.equal(shouldSkip({ draft: false, labels: ['wip', 'bug'] }, cfg), 'label')
})

test('a non-draft PR with no matching labels is not skipped', () => {
  const cfg = config({ skip_drafts: true, skip_labels: ['no-review'] })
  assert.equal(shouldSkip({ draft: false, labels: ['bug'] }, cfg), null)
})

test('an empty skip_labels list never triggers a "label" skip', () => {
  const cfg = config({ skip_drafts: false, skip_labels: [] })
  assert.equal(shouldSkip({ draft: false, labels: ['anything'] }, cfg), null)
})
