import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCost, resolveCostEstimateUsd, isBudgetTrackable } from './cost.ts'

test('T5.33: budget.pricing set -> cost = in/1e6 * P_in + out/1e6 * P_out', () => {
  const result = estimateCost(
    { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, (3 + 15).toFixed(4))
})

test('T5.34: budget.pricing not set -> cost_estimate_usd is an empty string (FR-74)', () => {
  const result = estimateCost({ promptTokens: 12000, completionTokens: 2000 })
  assert.equal(result, '')
})

test('T5.35: result is rounded to 4 decimal places', () => {
  const result = estimateCost(
    { promptTokens: 93450, completionTokens: 10000 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.match(result, /^\d+\.\d{4}$/)
})

test('T5.36: zero tokens -> "0.0000"', () => {
  const result = estimateCost(
    { promptTokens: 0, completionTokens: 0 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, '0.0000')
})

test('T5.37: control example from PRD §12.3 - 12000 in / 2000 out at $3/$15 -> "0.0660"', () => {
  const result = estimateCost(
    { promptTokens: 12000, completionTokens: 2000 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, '0.0660')
})

test('T5.38: control example from PRD §12.3 (agent, cached) - 93450 in / 10000 out at $3/$15 -> "0.4304"', () => {
  const result = estimateCost(
    { promptTokens: 93450, completionTokens: 10000 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, '0.4304')
})

// ---------------------------------------------------------------------------
// Дополнение A: resolveCostEstimateUsd() — provider-reported actual cost
// (usage.costUsd) takes priority over the budget.pricing estimate.
// ---------------------------------------------------------------------------

test('TA.7: usage.costUsd set -> used verbatim (formatted), even when pricing is ALSO set', () => {
  const result = resolveCostEstimateUsd(
    { promptTokens: 19, completionTokens: 5, costUsd: 0.00002654 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, '0.0000')
})

test('TA.8: usage.costUsd set, no pricing configured -> real cost is still used', () => {
  const result = resolveCostEstimateUsd({ promptTokens: 19, completionTokens: 5, costUsd: 1.2345 })
  assert.equal(result, '1.2345')
})

test('TA.9: usage.costUsd absent, pricing set -> falls back to estimateCost() (same as before)', () => {
  const result = resolveCostEstimateUsd(
    { promptTokens: 12000, completionTokens: 2000 },
    { inputPer1M: 3, outputPer1M: 15 }
  )
  assert.equal(result, '0.0660')
})

test('TA.10: neither usage.costUsd nor pricing set -> empty string (FR-74)', () => {
  const result = resolveCostEstimateUsd({ promptTokens: 12000, completionTokens: 2000 })
  assert.equal(result, '')
})

test('TA.11: usage.costUsd rounds to 4 decimals, including a round-down-to-zero case', () => {
  const result = resolveCostEstimateUsd({
    promptTokens: 19,
    completionTokens: 5,
    costUsd: 0.000049
  })
  assert.equal(result, '0.0000')
})

// ---------------------------------------------------------------------------
// Stage 8 (T8.5-T8.8): isBudgetTrackable() — whether a budget check should
// run at all, before any cost forecast is computed.
// ---------------------------------------------------------------------------

test('T8.7: max_cost_usd not set -> not trackable, no warning', () => {
  const warnings: string[] = []
  const result = isBudgetTrackable(undefined, { inputPer1M: 3, outputPer1M: 15 }, (m) => warnings.push(m))
  assert.equal(result, false)
  assert.equal(warnings.length, 0)
})

test('T8.8: max_cost_usd set, pricing not set -> not trackable, warns once', () => {
  const warnings: string[] = []
  const result = isBudgetTrackable(0.5, undefined, (m) => warnings.push(m))
  assert.equal(result, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /pricing/i)
})

test('T8.8b: both max_cost_usd and pricing set -> trackable, no warning', () => {
  const warnings: string[] = []
  const result = isBudgetTrackable(0.5, { inputPer1M: 3, outputPer1M: 15 }, (m) => warnings.push(m))
  assert.equal(result, true)
  assert.equal(warnings.length, 0)
})
