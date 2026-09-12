/**
 * Cost estimation (FR-74, PRD §12.2). Deliberately depends on nothing but a
 * token usage pair and an optional pricing config — no `ResolvedConfig`
 * import — so `format.ts`/`main.ts` can call it with whatever pricing they
 * already have in hand.
 */

export interface UsageTokens {
  promptTokens: number
  completionTokens: number
}

export interface Pricing {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number
}

/**
 * `ResolvedConfig['budget']['pricing']` (snake_case, as written in
 * `.github/code-review.yml`) -> `Pricing` (camelCase, this module's shape).
 * Takes a structural type rather than importing `ResolvedConfig` itself, to
 * keep this module's "depends on nothing" property (see file header) intact
 * — every caller (`main.ts`, `diff-engine.ts`, `agent-engine.ts`) needs this
 * exact conversion, so it lives here once instead of three times.
 */
export function toPricing (
  raw: { input_per_1m: number, output_per_1m: number } | undefined
): Pricing | undefined {
  if (raw === undefined) return undefined
  return { inputPer1M: raw.input_per_1m, outputPer1M: raw.output_per_1m }
}

/** Shared 4-decimal-place formatting, used both by the `budget.pricing`
 * estimate below and by the provider-reported actual cost (Дополнение A). */
function formatCostUsd (cost: number): string {
  return cost.toFixed(4)
}

/**
 * `cost = promptTokens/1e6 * inputPer1M + completionTokens/1e6 * outputPer1M`
 * (PRD §12.2), rounded to 4 decimal places. Without `pricing`, returns `''`
 * (FR-74) — there is nothing honest to report without a configured price.
 */
export function estimateCost (usage: UsageTokens, pricing?: Pricing): string {
  if (pricing === undefined) return ''
  const cost =
    (usage.promptTokens / 1e6) * pricing.inputPer1M +
    (usage.completionTokens / 1e6) * pricing.outputPer1M
  return formatCostUsd(cost)
}

/**
 * `cost_estimate_usd` (Дополнение A / FR-74, revised priority): prefer the
 * provider's own reported actual cost (`usage.costUsd`, e.g. OpenRouter's
 * `usage.cost` surfaced through `TokenUsage.costUsd`) over the
 * `budget.pricing` estimate, which in turn beats an empty string. Real cost
 * wins even when both are available — it is ground truth, the pricing
 * estimate is a guess.
 */
export function resolveCostEstimateUsd (
  usage: UsageTokens & { costUsd?: number },
  pricing?: Pricing
): string {
  if (usage.costUsd !== undefined) return formatCostUsd(usage.costUsd)
  return estimateCost(usage, pricing)
}

/**
 * `budget.max_cost_usd` enforcement (T8.5-T8.8, THR-8/R-13) is always
 * estimate-based, never provider-reported: a real per-call cost (Дополнение
 * A's `usage.costUsd`) only exists *after* a call completes, which is
 * useless for a pre-flight check (T8.5) and no more "live" than an estimate
 * for a mid-run one (T8.6) — so both need `budget.pricing` specifically,
 * regardless of what `cost_estimate_usd` ends up reporting. `warn` is a
 * caller-supplied callback (not `logger` directly) to keep this module free
 * of side-effecting dependencies, per the file-level note above.
 */
export function isBudgetTrackable (
  maxCostUsd: number | undefined,
  pricing: Pricing | undefined,
  warn: (message: string) => void
): boolean {
  if (maxCostUsd === undefined) return false
  if (pricing === undefined) {
    warn(
      'budget.max_cost_usd is set but budget.pricing is missing — cost cannot be forecast or ' +
        'enforced without it; continuing without a budget check.'
    )
    return false
  }
  return true
}
