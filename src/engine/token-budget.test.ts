import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAvailableBudget,
  outputReserveSoft,
  outputReserveHard,
  planBatches,
  OUTPUT_RESERVE_SOFT_FLOOR,
  OUTPUT_RESERVE_HARD_FLOOR
} from './token-budget.ts'
import { renderFile } from '../github/diff-render.ts'
import { estimateTokens } from '../provider/token-estimate.ts'
import type { DiffFile } from '../github/diff-parse.ts'

function makeFile (path: string, contentLength: number): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ type: 'add', content: 'x'.repeat(contentLength), newLineNumber: 1 }]
      }
    ]
  }
}

function fileTokens (file: DiffFile, contextLines = 3): number {
  return estimateTokens(renderFile(file, contextLines))
}

test('T4.1: everything fits under the budget -> a single batch containing every file', () => {
  const files = [makeFile('a.ts', 100), makeFile('b.ts', 100), makeFile('c.ts', 100)]
  const plan = planBatches({
    files,
    contextWindow: 128000,
    maxOutputTokens: 4000,
    maxModelCalls: 3,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })
  assert.equal(plan.batches.length, 1)
  assert.deepEqual(
    plan.batches[0]!.map((f) => f.path),
    ['a.ts', 'b.ts', 'c.ts']
  )
  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.truncated, false)
})

test('T4.2: available follows the exact §7.4 formula', () => {
  const available = computeAvailableBudget({
    contextWindow: 128000,
    systemPromptTokens: 500,
    fixedContextTokens: 200,
    maxOutputTokens: 4000
  })
  // max_output_tokens (4000) > the 1500 floor, so the soft reserve is 4000.
  assert.equal(available, 128000 - 500 - 200 - 4000)
})

test('T4.3: max_output_tokens: 8000 (> 1500) -> the reserve is 8000, not 1500 (R-1)', () => {
  assert.equal(outputReserveSoft(8000), 8000)
  const available = computeAvailableBudget({
    contextWindow: 20000,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    maxOutputTokens: 8000
  })
  assert.equal(available, 20000 - 8000)
})

test('T4.4: overflow with max_model_calls: 1 -> tail dropped, truncated: true, skipped non-empty', () => {
  const files = [makeFile('a.ts', 2000), makeFile('b.ts', 2000), makeFile('c.ts', 2000)]
  const perFile = fileTokens(files[0]!)
  const available = Math.floor(perFile * 1.5) // ~1 file fits per batch
  const contextWindow = available + OUTPUT_RESERVE_SOFT_FLOOR
  const plan = planBatches({
    files,
    contextWindow,
    maxOutputTokens: 100, // < 1500 floor -> reserve is exactly OUTPUT_RESERVE_SOFT_FLOOR
    maxModelCalls: 1,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })
  assert.equal(plan.batches.length, 1)
  assert.ok(plan.skipped.length > 0)
  assert.equal(plan.truncated, true)
})

test('T4.5: overflow with max_model_calls: 3 -> split into at most 3 batches', () => {
  const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.ts`, 2000))
  const perFile = fileTokens(files[0]!)
  const available = Math.floor(perFile * 2.5) // ~2 files fit per batch
  const contextWindow = available + OUTPUT_RESERVE_SOFT_FLOOR
  const plan = planBatches({
    files,
    contextWindow,
    maxOutputTokens: 100,
    maxModelCalls: 3,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })
  assert.ok(plan.batches.length >= 1 && plan.batches.length <= 3)
})

test('T4.6: overflow beyond max_model_calls: 3 -> exactly 3 batches + skipped tail', () => {
  const files = Array.from({ length: 10 }, (_, i) => makeFile(`f${i}.ts`, 2000))
  const perFile = fileTokens(files[0]!)
  const available = Math.floor(perFile * 2.5) // ~2 files fit per batch -> 6 of 10 fit in 3 batches
  const contextWindow = available + OUTPUT_RESERVE_SOFT_FLOOR
  const plan = planBatches({
    files,
    contextWindow,
    maxOutputTokens: 100,
    maxModelCalls: 3,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })
  assert.equal(plan.batches.length, 3)
  assert.ok(plan.skipped.length > 0)
  assert.equal(plan.truncated, true)
  assert.ok(plan.skipped.every((s) => s.reason === 'max_model_calls'))
})

test('T4.7: a single file larger than the whole budget goes to skipped, no infinite loop', () => {
  const bigFile = makeFile('huge.ts', 100000)
  const smallFile = makeFile('small.ts', 50)
  const plan = planBatches({
    files: [bigFile, smallFile],
    contextWindow: 2000,
    maxOutputTokens: 100,
    maxModelCalls: 3,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })
  assert.ok(plan.skipped.some((s) => s.path === 'huge.ts' && s.reason === 'exceeds_token_budget'))
  assert.ok(plan.batches.flat().some((f) => f.path === 'small.ts'))
})

test('T4.8: path_instructions-matched files are prioritized into the first batch on overflow', () => {
  const files = [makeFile('a.ts', 2000), makeFile('b.ts', 2000), makeFile('important.ts', 2000)]
  const perFile = fileTokens(files[0]!)
  const available = Math.floor(perFile * 1.5) // ~1 file fits per batch
  const contextWindow = available + OUTPUT_RESERVE_SOFT_FLOOR
  const plan = planBatches({
    files,
    contextWindow,
    maxOutputTokens: 100,
    maxModelCalls: 1,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: [{ path: 'important.ts', instructions: 'review carefully' }]
  })
  assert.deepEqual(
    plan.batches[0]!.map((f) => f.path),
    ['important.ts']
  )
})

test('T4.9: packing stops at the soft-reserve budget, not the (larger) hard-reserve one', () => {
  const fileA = makeFile('a.ts', 200)
  const fileB = makeFile('b.ts', 200)
  const perFile = fileTokens(fileA)
  const combined = perFile * 2

  // max_output_tokens small enough that the soft (1500 floor) and hard
  // (1000 floor) reserves differ. Size the window so both files together
  // exceed the soft-budget target but comfortably fit under the hard-budget
  // one: an implementation that (incorrectly) packed against the hard
  // reserve would fit both files in a single batch; packing against the
  // soft reserve (the correct behaviour, per §7.4) must not.
  const maxOutputTokens = 100
  const availableSoft = Math.max(1, Math.floor(combined * 0.8)) // < combined -> forces a split
  const contextWindow = availableSoft + OUTPUT_RESERVE_SOFT_FLOOR
  const availableHard = contextWindow - OUTPUT_RESERVE_HARD_FLOOR

  assert.ok(
    availableHard >= combined,
    'test setup invariant: both files must fit together under the HARD reserve for this to be a meaningful check'
  )
  assert.equal(outputReserveHard(maxOutputTokens), OUTPUT_RESERVE_HARD_FLOOR)

  const plan = planBatches({
    files: [fileA, fileB],
    contextWindow,
    maxOutputTokens,
    maxModelCalls: 3,
    contextLines: 3,
    systemPromptTokens: 0,
    fixedContextTokens: 0,
    pathInstructions: []
  })

  assert.ok(
    plan.batches.length >= 2,
    `expected packing to stop before the soft budget was exceeded, producing >1 batch, got ${plan.batches.length}`
  )
})
