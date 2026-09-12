import * as core from '@actions/core'
import * as github from '@actions/github'
import type { ResolvedConfig } from './config/schema.ts'
import type { GithubContext } from './github/context.ts'
import type { PositionMap } from './github/position-map.ts'
import type { SkippedFile } from './github/diff-parse.ts'
import type { ReviewTarget, ReviewResult, ReviewContext } from './engine/types.ts'
import { dedupeFindings } from './report/dedupe.ts'
import {
  sortAndTruncate,
  severityMax,
  shouldFailFromMax,
  type SeverityMax
} from './report/severity.ts'
import { formatReviewEntry, formatJobSummary, type FormatSummaryParams } from './report/format.ts'
import { resolveCostEstimateUsd, estimateCost, isBudgetTrackable, toPricing } from './report/cost.ts'
import { publishReview, listExistingReviewComments } from './github/review.ts'
import {
  upsertStickyComment,
  findStickyComment,
  extractStickyState
} from './github/sticky-comment.ts'
import { readInputs } from './config/inputs.ts'
import { readFileConfig } from './config/file-config.ts'
import { mergeConfig, isLanguageExplicit } from './config/merge.ts'
import { DEFAULTS } from './config/defaults.ts'
import { resolveReviewLanguage } from './config/language.ts'
import { createGithubContext } from './github/context.ts'
import { shouldSkip, type PullRequestInfo } from './github/pull-request.ts'
import { getDiff } from './github/diff.ts'
import { selectFiles } from './github/select-files.ts'
import { buildPositionMap } from './github/position-map.ts'
import { renderFile } from './github/diff-render.ts'
import type { DiffFile } from './github/diff-parse.ts'
import { estimateTokens } from './provider/token-estimate.ts'
import { createProviderAdapter } from './provider/factory.ts'
import { selectEngine } from './engine/selector.ts'
import { logger } from './util/logger.ts'
import { AppError, CapabilityError } from './util/errors.ts'
import { redact } from './util/secrets.ts'

/** §8.2 PRD: the only allowed values of the `skipped_reason` output. */
export type SkippedReason =
  '' | 'draft' | 'label' | 'no_changes' | 'budget_exceeded' | 'capability_check_failed'

/**
 * §8.2 PRD (verbatim, 13 outputs) — the single source of truth for this
 * action's outputs. Every value is already a string (GitHub Actions outputs
 * are always strings; the "Формат содержимого" column of §8.2 just
 * documents what a consumer should parse it as).
 */
export interface MainOutputs {
  review_id: string
  mode_used: string
  comments_posted: string
  files_reviewed: string
  files_skipped: string
  skipped_files: string
  findings_total: string
  severity_max: string
  tokens_input: string
  tokens_output: string
  cost_estimate_usd: string
  skipped_reason: string
  truncated: string
  /** Дополнение G (FR-53): findings dropped by the noise-filter pass. Always '0' unless
   * `mode: agent` ran with `agent.filter_model` configured. */
  findings_filtered: string
}

const OUTPUT_KEYS = [
  'review_id',
  'mode_used',
  'comments_posted',
  'files_reviewed',
  'files_skipped',
  'skipped_files',
  'findings_total',
  'severity_max',
  'tokens_input',
  'tokens_output',
  'cost_estimate_usd',
  'skipped_reason',
  'truncated',
  'findings_filtered'
] as const satisfies readonly (keyof MainOutputs)[]

/** Safe, "nothing happened" defaults for an early exit (draft/label/no_changes/..., T5.47). */
export function defaultOutputs (skippedReason: SkippedReason = ''): MainOutputs {
  return {
    review_id: '',
    mode_used: '',
    comments_posted: '0',
    files_reviewed: '0',
    files_skipped: '0',
    skipped_files: '[]',
    findings_total: '0',
    severity_max: 'none',
    tokens_input: '0',
    tokens_output: '0',
    cost_estimate_usd: '',
    skipped_reason: skippedReason,
    truncated: 'false',
    findings_filtered: '0'
  }
}

/** FR-70: sets every one of the 14 §8.2 outputs, every run, unconditionally (T5.46). */
export function setAllOutputs (outputs: MainOutputs): void {
  for (const key of OUTPUT_KEYS) {
    core.setOutput(key, outputs[key])
  }
}

export interface PrPhaseResult {
  draft: boolean
  labels: string[]
  title: string
  body: string | null
  headSha: string
  /** Non-`null` -> `run()` stops here (FR-14/FR-15, T5.47). */
  skipReason: 'draft' | 'label' | null
}

export interface DiffPhaseResult {
  target: ReviewTarget
  positionMap: PositionMap
  /** Set only for "nothing changed since the last review" (T2.40-style early exit). */
  skippedReason?: 'no_changes'
}

export interface EnginePhaseResult {
  reviewResult: ReviewResult
  engineName: 'diff' | 'agent'
}

/** Raw shape of the fields `fetchPr` reads off `pulls.get`'s response (T6). */
interface PullsGetData {
  draft?: boolean
  labels?: Array<{ name?: string | null } | null> | null
  title?: string | null
  body?: string | null
  head: { sha: string }
}

/**
 * Mutable seams for tests, same rationale as every other `internals` object
 * in this codebase (`@actions/core`/`@actions/github` are pure ESM with
 * immutable exports).
 *
 * Stage 6: real, end-to-end wiring of the modules stage 1-4 already built
 * and tested individually: `config/inputs.ts` + `config/file-config.ts` +
 * `config/merge.ts` for `loadConfig`; `github/context.ts` for
 * `createContext`; `github/pull-request.ts` (`shouldSkip`) + a
 * `pulls.get` metadata read for `fetchPr`; `github/sticky-comment.ts`
 * (`findStickyComment`/`extractStickyState`, for `lastReviewedSha`) +
 * `github/diff.ts` + `github/select-files.ts` + `github/position-map.ts`
 * for `fetchDiff`; `provider/factory.ts` + `engine/selector.ts` for
 * `runEngine`. Stage 5's scope was the *publish* phase
 * (`publishAndBuildOutputs` below, and the `github/review.ts`,
 * `github/sticky-comment.ts`, `report/**` modules it composes) — that part
 * was already fully real; `run()`'s call order (config -> pr -> diff ->
 * engine -> publish, T5.48) is unchanged, only the four phases above are now
 * real instead of stubs.
 */
export const internals = {
  isPullRequestEvent (): boolean {
    return process.env.GITHUB_EVENT_NAME === 'pull_request'
  },

  async loadConfig (): Promise<{ config: ResolvedConfig; languageExplicit: boolean }> {
    const inputs = readInputs()
    const fileConfig = await readFileConfig(inputs.config_path)
    return {
      config: mergeConfig(inputs, fileConfig),
      languageExplicit: isLanguageExplicit(inputs, fileConfig)
    }
  },

  createContext (config: ResolvedConfig): GithubContext {
    return createGithubContext(config.github_token, github.context)
  },

  async fetchPr (context: GithubContext, config: ResolvedConfig): Promise<PrPhaseResult> {
    const res = await context.client.rest.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.prNumber
    })
    const data = res.data as PullsGetData
    const draft = data.draft ?? false
    const labels = (data.labels ?? [])
      .map((l) => l?.name ?? '')
      .filter((name): name is string => name !== '')
    const title = data.title ?? ''
    const body = data.body ?? null
    const headSha = data.head.sha

    const pr: PullRequestInfo = { draft, labels }
    const skipReason = shouldSkip(pr, config)

    return { draft, labels, title, body, headSha, skipReason }
  },

  async fetchDiff (
    context: GithubContext,
    config: ResolvedConfig,
    pr: PrPhaseResult
  ): Promise<DiffPhaseResult> {
    const sticky = await findStickyComment(context.client, {
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber
    })
    const stickyState = sticky ? extractStickyState(sticky.body) : null
    const lastReviewedSha = stickyState?.last_reviewed_sha ?? null

    const diffResult = await getDiff(context.client, {
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      headSha: pr.headSha,
      incremental: config.incremental,
      lastReviewedSha
    })

    if (diffResult.skippedReason === 'no_changes') {
      return {
        target: { files: [], skipped: [] },
        positionMap: buildPositionMap([]),
        skippedReason: 'no_changes'
      }
    }

    const selectResult = selectFiles({
      files: diffResult.files,
      include: config.filters.include,
      exclude: config.filters.exclude,
      maxFiles: config.filters.max_files,
      maxDiffBytes: config.filters.max_diff_bytes,
      pathInstructions: config.review.path_instructions
    })

    if (selectResult.skippedReason === 'no_changes') {
      return {
        target: { files: [], skipped: [] },
        positionMap: buildPositionMap([]),
        skippedReason: 'no_changes'
      }
    }

    const target: ReviewTarget = {
      files: selectResult.files,
      skipped: [...diffResult.skippedFiles, ...selectResult.skipped]
    }

    return { target, positionMap: buildPositionMap(selectResult.files) }
  },

  async runEngine (
    config: ResolvedConfig,
    context: GithubContext,
    pr: PrPhaseResult,
    diff: DiffPhaseResult
  ): Promise<EnginePhaseResult> {
    const provider = createProviderAdapter(config)
    // Дополнение G (FR-53): same api_key/base_url/flavor as `provider`, just a cheaper `model` —
    // `AgentEngine` reads this only when `agent.filter_model` is set (see engine/types.ts).
    const filterProvider =
      config.agent.filter_model !== ''
        ? createProviderAdapter({ ...config, model: config.agent.filter_model })
        : undefined
    const signal = AbortSignal.timeout(config.api.total_timeout_ms)
    const engine = await selectEngine(config, provider, signal, diff.target.files.length)

    const reviewContext: ReviewContext = {
      config,
      provider,
      target: diff.target,
      pr: { number: context.prNumber, title: pr.title, body: pr.body },
      signal,
      ...(filterProvider !== undefined ? { filterProvider } : {})
    }

    const reviewResult = await engine.review(reviewContext)
    return { reviewResult, engineName: engine.name }
  }
}

/**
 * T8.5 pre-flight budget check's prompt-token estimate: the same per-file
 * `estimateTokens(renderFile(...))` `token-budget.ts` uses for packing,
 * summed across every file in scope. Deliberately a floor, not a full-run
 * estimate — it ignores the system prompt and (for `mode: diff`) any
 * multi-batch splitting, and (for `mode: agent`) the tool-loop's growing
 * history entirely. Good enough to catch a budget that is already blown by
 * the diff alone (THR-8's actual concern — a giant PR), not a precise
 * per-mode forecast.
 */
function estimateDiffTokens (files: readonly DiffFile[], contextLines: number): number {
  return files.reduce((sum, file) => sum + estimateTokens(renderFile(file, contextLines)), 0)
}

export interface PublishPhaseInput {
  config: ResolvedConfig
  context: GithubContext
  headSha: string
  reviewResult: ReviewResult
  positionMap: PositionMap
  filesReviewed: number
  filesSkipped: SkippedFile[]
  mode: string
  /** Дополнение C: ISO timestamp `run()` started at, embedded in the new history entry's header. */
  startedAt: string
}

/**
 * The publish phase (FR-60..FR-74, §7.3 steps 5-6): dedupe -> sort/truncate
 * (the single `max_comments` truncation point, FR-66) -> publish the review
 * (three-layer 422 defense, §7.5) -> upsert the sticky summary comment with
 * the new state -> build every §8.2 output. Fully real (unlike the
 * `internals` stubs above) — this is stage 5's actual deliverable.
 */
export async function publishAndBuildOutputs (input: PublishPhaseInput): Promise<MainOutputs> {
  const existingComments = await listExistingReviewComments(input.context.client, {
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber
  })

  const deduped = dedupeFindings(input.reviewResult.findings, existingComments)
  const { kept, overflow } = sortAndTruncate(deduped, input.config.review.max_comments)

  const publishResult = await publishReview(input.context.client, {
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    model: input.config.model,
    findings: kept,
    positionMap: input.positionMap,
    dryRun: input.config.dry_run,
    summaryOnly: input.config.review.summary_only
  })

  const unpostedForSummary = [...publishResult.unpostedFindings, ...overflow]
  const dedupedSeverityMax: SeverityMax = severityMax(deduped)
  const costEstimateUsd = resolveCostEstimateUsd(
    {
      promptTokens: input.reviewResult.usage.promptTokens,
      completionTokens: input.reviewResult.usage.completionTokens,
      ...(input.reviewResult.usage.costUsd !== undefined
        ? { costUsd: input.reviewResult.usage.costUsd }
        : {})
    },
    toPricing(input.config.budget.pricing)
  )
  const truncated =
    input.reviewResult.truncated || overflow.length > 0 || input.filesSkipped.length > 0

  const formatParams: FormatSummaryParams = {
    postedFindings: publishResult.postedFindings,
    unpostedFindings: unpostedForSummary,
    notes: input.reviewResult.notes,
    truncated,
    skippedFiles: input.filesSkipped,
    tokensInput: input.reviewResult.usage.promptTokens,
    tokensOutput: input.reviewResult.usage.completionTokens,
    mode: input.mode,
    model: input.config.model,
    costEstimateUsd,
    filesReviewed: input.filesReviewed,
    severityMax: dedupedSeverityMax,
    findingsFiltered: input.reviewResult.findingsFiltered
  }

  const entryMarkdown = formatReviewEntry({
    ...formatParams,
    reviewId: publishResult.reviewId,
    startedAt: input.startedAt
  })
  const jobSummaryMarkdown = formatJobSummary(formatParams)

  await upsertStickyComment(input.context.client, {
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    entryMarkdown,
    state: { last_reviewed_sha: input.headSha, version: 1 },
    dryRun: input.config.dry_run,
    language: input.config.review.language
  })

  // Job Summary (FR-71) is best-effort: `GITHUB_STEP_SUMMARY` is only set on
  // a real Actions runner, never in local dev/unit tests, and a missing job
  // summary must never fail an otherwise-successful run.
  try {
    await core.summary.addRaw(jobSummaryMarkdown).write()
  } catch {
    core.summary.emptyBuffer()
  }

  return {
    review_id: publishResult.reviewId !== null ? String(publishResult.reviewId) : '',
    mode_used: input.mode,
    comments_posted: String(input.config.dry_run ? 0 : publishResult.postedFindings.length),
    files_reviewed: String(input.filesReviewed),
    files_skipped: String(input.filesSkipped.length),
    skipped_files: JSON.stringify(input.filesSkipped.map((f) => f.path)),
    findings_total: String(deduped.length),
    severity_max: dedupedSeverityMax,
    tokens_input: String(input.reviewResult.usage.promptTokens),
    tokens_output: String(input.reviewResult.usage.completionTokens),
    cost_estimate_usd: costEstimateUsd,
    skipped_reason: '',
    truncated: String(truncated),
    findings_filtered: String(input.reviewResult.findingsFiltered)
  }
}

export async function run (): Promise<void> {
  // Tracks whether the try block already reached a `setAllOutputs()` call
  // (an early skip exit, or the final publish) before an exception surfaced
  // to `catch`. Without this, a throw *after* a successful publish (e.g. an
  // unexpected error while evaluating `fail_on_severity`) would have the
  // catch block clobber the just-published outputs with early-exit defaults.
  let outputsSet = false
  try {
    // Дополнение C: captured once at the top of the run so every phase that
    // needs it (only the publish phase, today) sees the same instant this
    // run started, embedded verbatim in the new sticky-comment history entry.
    const startedAt = new Date().toISOString()

    if (!internals.isPullRequestEvent()) {
      core.setFailed(
        'This action only supports the pull_request event (GITHUB_EVENT_NAME is not "pull_request").'
      )
      return
    }

    // FR-72 (T8.10): every phase below runs inside its own `core.startGroup`/
    // `endGroup` pair — config/diff/model/publish, in that order.
    const { context, pr, config } = await logger.group('config', async () => {
      const { config: loadedConfig, languageExplicit } = await internals.loadConfig()
      const context = internals.createContext(loadedConfig)
      const pr = await internals.fetchPr(context, loadedConfig)

      // Дополнение B: PR title-based auto-detect of review.language, only when
      // it was not set explicitly anywhere (input or `.github/code-review.yml`).
      const language = resolveReviewLanguage({
        explicitLanguage: languageExplicit ? loadedConfig.review.language : undefined,
        prTitle: pr.title,
        defaultLanguage: DEFAULTS.language
      })
      const config: ResolvedConfig = {
        ...loadedConfig,
        review: { ...loadedConfig.review, language }
      }
      return { context, pr, config }
    })

    if (pr.skipReason) {
      setAllOutputs(defaultOutputs(pr.skipReason))
      outputsSet = true
      return
    }

    const diff = await logger.group('diff', () => internals.fetchDiff(context, config, pr))
    if (diff.skippedReason) {
      setAllOutputs(defaultOutputs(diff.skippedReason))
      outputsSet = true
      return
    }

    const modelPhase = await logger.group('model', async () => {
      // T8.5/T8.7/T8.8: a hard safety fuse (THR-8/R-13) — reject before ever
      // calling the model if even a floor estimate (see `estimateDiffTokens`)
      // already exceeds `budget.max_cost_usd`. No-op unless both `max_cost_usd`
      // and `budget.pricing` are configured (`isBudgetTrackable`).
      const pricing = toPricing(config.budget.pricing)
      if (isBudgetTrackable(config.budget.max_cost_usd, pricing, (m) => logger.warning(m))) {
        const promptTokensEstimate = estimateDiffTokens(diff.target.files, config.filters.context_lines)
        const forecast = estimateCost(
          { promptTokens: promptTokensEstimate, completionTokens: config.review.max_output_tokens },
          pricing
        )
        if (forecast !== '' && Number(forecast) > config.budget.max_cost_usd!) {
          logger.warning(
            `Estimated cost ($${forecast}) exceeds budget.max_cost_usd ` +
              `($${config.budget.max_cost_usd}) — stopping before calling the model.`
          )
          return { skipped: true as const }
        }
      }
      const outcome = await internals.runEngine(config, context, pr, diff)
      return { skipped: false as const, outcome }
    })

    if (modelPhase.skipped) {
      setAllOutputs(defaultOutputs('budget_exceeded'))
      outputsSet = true
      return
    }
    const engineOutcome = modelPhase.outcome

    const outputs = await logger.group('publish', () =>
      publishAndBuildOutputs({
        config,
        context,
        headSha: pr.headSha,
        reviewResult: engineOutcome.reviewResult,
        positionMap: diff.positionMap,
        filesReviewed: diff.target.files.length,
        filesSkipped: diff.target.skipped,
        mode: engineOutcome.engineName,
        startedAt
      })
    )

    // FR-67/T5.48: publish first, THEN decide whether to fail the job.
    setAllOutputs(outputs)
    outputsSet = true

    if (shouldFailFromMax(outputs.severity_max as SeverityMax, config.review.fail_on_severity)) {
      core.setFailed(
        `The review found finding(s) at or above the configured fail_on_severity ("${config.review.fail_on_severity}").`
      )
    }
  } catch (error) {
    // §8.2: `CapabilityError` gets its own dedicated `skipped_reason` so a
    // consumer can distinguish "this model can't do agent mode" from every
    // other failure. `outputsSet` guards against clobbering outputs a
    // successful phase already published (see the comment at the top of
    // `run()`).
    if (!outputsSet) {
      const reason: SkippedReason = error instanceof CapabilityError ? 'capability_check_failed' : ''
      setAllOutputs(defaultOutputs(reason))
    }

    // AppError#toUserMessage() already appends the hint and redacts secrets
    // (util/errors.ts); anything else (a bug, a thrown non-Error) still needs
    // redaction before it can safely reach `core.setFailed` (THR-1/THR-2).
    const message = error instanceof AppError
      ? error.toUserMessage()
      : redact(error instanceof Error ? error.message : String(error))
    core.setFailed(message)
  }
}
