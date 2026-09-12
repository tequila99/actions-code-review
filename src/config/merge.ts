import { DEFAULTS, DEFAULT_EXCLUDE, CUSTOM_INSTRUCTIONS_MAX_LENGTH } from './defaults.ts'
import { parseResolvedConfig, type ResolvedConfig, type FileConfig } from './schema.ts'
import type { RawInputs } from './inputs.ts'
import { ConfigError } from '../util/errors.ts'
import { logger } from '../util/logger.ts'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Scalar merge rule (PRD §9.1): input wins, then file, then default. An
 * `undefined` input (never an empty string — `inputs.ts` already treats
 * `''` as "not provided") falls through to the file value, then to the
 * default.
 */
function pickScalar<T> (inputValue: T | undefined, fileValue: T | undefined, defaultValue: T): T {
  if (inputValue !== undefined) return inputValue
  if (fileValue !== undefined) return fileValue
  return defaultValue
}

function normalizeBaseUrl (url: string): string {
  return url.replace(/\/+$/, '')
}

function tryGetHostname (url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Дополнение E (FR-10b): same priority as every other `review.*` scalar (FR-6), plus a hard
 * length cap so a careless/malicious value can't grow the system prompt unboundedly. */
function resolveCustomInstructions (
  inputValue: string | undefined,
  fileValue: string | undefined
): string {
  const raw = pickScalar(inputValue, fileValue, DEFAULTS.custom_instructions)
  if (raw.length <= CUSTOM_INSTRUCTIONS_MAX_LENGTH) return raw
  logger.warning(
    `custom_instructions is ${raw.length} characters, longer than the ${CUSTOM_INSTRUCTIONS_MAX_LENGTH}-character limit — truncated.`
  )
  return raw.slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH)
}

/**
 * Post-merge FR-10a check: `api_base_url` must be `https://`, except for
 * loopback addresses or an explicit `allow_insecure_base_url: true`. This
 * cannot run inside `inputs.ts` because the final `base_url` may come from
 * `.github/code-review.yml` (`api.base_url`), while `allow_insecure_base_url`
 * only exists as a workflow input — both are only simultaneously available
 * here, after merging (T1.23/24/54/61).
 */
function assertSecureBaseUrl (baseUrl: string, allowInsecureBaseUrl: boolean): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new ConfigError(`\`api_base_url\` is not a valid URL: "${baseUrl}".`)
  }

  if (url.protocol === 'https:') return
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return

  if (allowInsecureBaseUrl) {
    logger.warning(
      `api_base_url uses an insecure transport (${url.protocol}//${url.hostname}). ` +
        'Allowed because `allow_insecure_base_url: true` was set.'
    )
    return
  }

  throw new ConfigError(
    `\`api_base_url\` must use https:// (got "${url.protocol}//${url.hostname}").`,
    'Loopback addresses (localhost/127.0.0.1/::1) are exempt. For a trusted internal ' +
      'endpoint over plain http, set `allow_insecure_base_url: true` explicitly (THR-7).'
  )
}

/**
 * THR-11: `web_search`'s handler only ever talks to OpenRouter's
 * `openrouter:web_search` server tool — enabling it against any other
 * endpoint means every call fails at runtime. Warns (does not block, same
 * shape as `assertSecureBaseUrl`'s `allow_insecure_base_url` branch) so the
 * mismatch is visible in the workflow log instead of surfacing only as a
 * string of per-call tool errors the model has to make sense of.
 */
function warnIfWebSearchRequiresOpenRouter (enabled: boolean, baseUrl: string): void {
  if (!enabled) return
  const hostname = tryGetHostname(baseUrl)
  // Already rejected by assertSecureBaseUrl before this runs if baseUrl is unparseable.
  if (hostname === null || hostname === 'openrouter.ai') return
  logger.warning(
    `agent_web_search is enabled, but api_base_url ("${hostname}") is not OpenRouter. The ` +
      "web_search tool only works against OpenRouter's openrouter:web_search server tool — it " +
      'will return a tool error every time it is called. Set api_base_url to OpenRouter ' +
      '(https://openrouter.ai/api/v1) or set agent_web_search: false.'
  )
}

/**
 * Merges action inputs, `.github/code-review.yml`, and defaults into a
 * single validated `ResolvedConfig` (FR-6, PRD §9.1). Throws `ConfigError`
 * on an invalid merged result, including the post-merge FR-10a check.
 */
export function mergeConfig (inputs: RawInputs, file: FileConfig): ResolvedConfig {
  const exclude = Array.from(
    new Set([...DEFAULT_EXCLUDE, ...(file.filters?.exclude ?? []), ...inputs.exclude])
  )
  const include = inputs.include.length > 0 ? inputs.include : (file.filters?.include ?? [])
  const skipLabels =
    inputs.skip_labels.length > 0 ? inputs.skip_labels : (file.filters?.skip_labels ?? [])

  // api.headers: input merges over file, input wins on key collision.
  const headers: Record<string, string> = { ...(file.api?.headers ?? {}), ...inputs.api_headers }

  const rawBaseUrl = pickScalar(
    inputs.api_base_url === '' ? undefined : inputs.api_base_url,
    file.api?.base_url,
    DEFAULTS.api_base_url
  )
  const baseUrl = normalizeBaseUrl(rawBaseUrl)
  const allowInsecureBaseUrl = inputs.allow_insecure_base_url

  const resolvedRaw = {
    version: DEFAULTS.version,
    mode: pickScalar(inputs.mode, file.mode, DEFAULTS.mode),
    model: pickScalar(inputs.model === '' ? undefined : inputs.model, file.model, ''),
    github_token: inputs.github_token,
    config_path: inputs.config_path,
    api: {
      base_url: baseUrl,
      api_key: inputs.api_key,
      flavor: pickScalar(inputs.api_flavor, file.api?.flavor, DEFAULTS.api_flavor),
      context_window: pickScalar(
        inputs.context_window,
        file.api?.context_window,
        DEFAULTS.context_window
      ),
      request_timeout_ms: pickScalar(
        inputs.request_timeout_ms,
        file.api?.request_timeout_ms,
        DEFAULTS.request_timeout_ms
      ),
      total_timeout_ms: pickScalar(
        inputs.total_timeout_ms,
        file.api?.total_timeout_ms,
        DEFAULTS.total_timeout_ms
      ),
      headers,
      allow_insecure_base_url: allowInsecureBaseUrl,
      ...(inputs.temperature !== undefined ? { temperature: inputs.temperature } : {})
    },
    filters: {
      include,
      exclude,
      max_files: pickScalar(inputs.max_files, file.filters?.max_files, DEFAULTS.max_files),
      max_diff_bytes: pickScalar(
        inputs.max_diff_bytes,
        file.filters?.max_diff_bytes,
        DEFAULTS.max_diff_bytes
      ),
      skip_drafts: pickScalar(inputs.skip_drafts, file.filters?.skip_drafts, DEFAULTS.skip_drafts),
      skip_labels: skipLabels,
      context_lines: pickScalar(undefined, file.filters?.context_lines, DEFAULTS.context_lines)
    },
    review: {
      language: pickScalar(inputs.language, file.review?.language, DEFAULTS.language),
      max_comments: pickScalar(
        inputs.max_comments,
        file.review?.max_comments,
        DEFAULTS.max_comments
      ),
      max_output_tokens: pickScalar(
        inputs.max_output_tokens,
        undefined,
        DEFAULTS.max_output_tokens
      ),
      max_model_calls: pickScalar(inputs.max_model_calls, undefined, DEFAULTS.max_model_calls),
      fail_on_severity: pickScalar(
        inputs.fail_on_severity,
        file.review?.fail_on_severity,
        DEFAULTS.fail_on_severity
      ),
      summary_only: pickScalar(
        inputs.summary_only,
        file.review?.summary_only,
        DEFAULTS.summary_only
      ),
      custom_instructions: resolveCustomInstructions(
        inputs.custom_instructions,
        file.review?.custom_instructions
      ),
      focus: file.review?.focus ?? [],
      ignore: file.review?.ignore ?? [],
      // File-only (PRD §9.1): not expressible as an action input.
      path_instructions: file.review?.path_instructions ?? []
    },
    // File-only (PRD §9.1).
    context: {
      always: file.context?.always ?? [],
      layers: file.context?.layers ?? [],
      max_context_bytes: file.context?.max_context_bytes ?? DEFAULTS.max_context_bytes
    },
    agent: {
      max_iterations: pickScalar(
        inputs.agent_max_iterations,
        file.agent?.max_iterations,
        DEFAULTS.agent_max_iterations
      ),
      max_tool_calls: pickScalar(
        inputs.agent_max_tool_calls,
        file.agent?.max_tool_calls,
        DEFAULTS.agent_max_tool_calls
      ),
      token_budget: pickScalar(
        inputs.agent_token_budget,
        file.agent?.token_budget,
        DEFAULTS.agent_token_budget
      ),
      tool_output_max_bytes: file.agent?.tool_output_max_bytes ?? DEFAULTS.tool_output_max_bytes,
      allow_suggestions: pickScalar(
        inputs.agent_allow_suggestions,
        file.agent?.allow_suggestions,
        DEFAULTS.agent_allow_suggestions
      ),
      // File-only (PRD §9.1).
      tools: file.agent?.tools ?? [],
      web_search: {
        enabled: pickScalar(
          inputs.agent_web_search,
          file.agent?.web_search?.enabled,
          DEFAULTS.agent_web_search
        ),
        max_calls: pickScalar(
          inputs.agent_web_search_max_calls,
          file.agent?.web_search?.max_calls,
          DEFAULTS.agent_web_search_max_calls
        )
      },
      filter_model: pickScalar(
        inputs.agent_filter_model,
        file.agent?.filter_model,
        DEFAULTS.agent_filter_model
      )
    },
    // File-only (PRD §9.1).
    budget: {
      ...(file.budget?.max_cost_usd !== undefined
        ? { max_cost_usd: file.budget.max_cost_usd }
        : {}),
      ...(file.budget?.pricing !== undefined ? { pricing: file.budget.pricing } : {})
    },
    incremental: pickScalar(inputs.incremental, undefined, DEFAULTS.incremental),
    auto_threshold_files: pickScalar(
      inputs.auto_threshold_files,
      undefined,
      DEFAULTS.auto_threshold_files
    ),
    dry_run: pickScalar(inputs.dry_run, undefined, DEFAULTS.dry_run),
    debug: pickScalar(inputs.debug, undefined, DEFAULTS.debug)
  }

  assertSecureBaseUrl(resolvedRaw.api.base_url, resolvedRaw.api.allow_insecure_base_url)

  // Reject as early as possible (config-merge time, not provider-construction
  // time): `provider/factory.ts` still has its own `case 'gemini'` guard as
  // defense in depth for a ResolvedConfig assembled any other way, but a user
  // who sets api_flavor: gemini should see this before the run gets any
  // further (stage 9b, FR-28).
  if (resolvedRaw.api.flavor === 'gemini') {
    throw new ConfigError(
      'api_flavor "gemini" is not supported yet (planned for stage 9b).',
      'Use api_flavor: "openai" (works with vLLM/Ollama/OpenRouter/any OpenAI-compatible gateway) or "anthropic" for now.'
    )
  }

  warnIfWebSearchRequiresOpenRouter(resolvedRaw.agent.web_search.enabled, resolvedRaw.api.base_url)

  return parseResolvedConfig(resolvedRaw)
}

/**
 * Дополнение B: whether `review.language` was set explicitly (input or
 * `.github/code-review.yml`), as opposed to falling through to
 * `DEFAULTS.language`. `mergeConfig()` itself is unchanged — this is a
 * separate, read-only check over the same two sources so `main.ts` can
 * decide whether PR-title auto-detection should run at all.
 */
export function isLanguageExplicit (inputs: RawInputs, file: FileConfig): boolean {
  return inputs.language !== undefined || file.review?.language !== undefined
}
