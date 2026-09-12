import * as core from '@actions/core'
import { registerSecret } from '../util/secrets.ts'
import { logger } from '../util/logger.ts'
import { ConfigError } from '../util/errors.ts'
import { DEFAULT_CONFIG_PATH } from './defaults.ts'

/**
 * Raw values read straight from `core.getInput`/env, with a per-field
 * default resolved *only* where the plan calls for it (`config_path`).
 * Every other optional numeric/boolean/string field is omitted entirely
 * (not set to `undefined`) when the input is an empty string, so
 * `config/merge.ts` can tell "not provided" apart from "provided as the
 * same value as the default" (PRD §9.1: "пустая строка input = не задано").
 * `total_timeout_ms` follows this same omit-when-unset rule (rather than
 * defaulting here) so a `.github/code-review.yml`-only value can win over
 * the default at merge time (FR-6).
 *
 * NB (FR-10a): `api_base_url` https-vs-insecure validation deliberately
 * does NOT happen here — it happens post-merge in `merge.ts`, because
 * `base_url` may come from `.github/code-review.yml` while
 * `allow_insecure_base_url` only exists as an input (see T1.23/24/54/61).
 */
export interface RawInputs {
  github_token: string
  api_key: string
  api_base_url: string
  model: string
  api_headers: Record<string, string>
  allow_insecure_base_url: boolean
  config_path: string
  include: string[]
  exclude: string[]
  skip_labels: string[]
  total_timeout_ms?: number
  api_flavor?: 'openai' | 'anthropic' | 'gemini'
  mode?: 'diff' | 'agent' | 'auto'
  max_files?: number
  max_diff_bytes?: number
  max_comments?: number
  max_output_tokens?: number
  max_model_calls?: number
  context_window?: number
  temperature?: number
  request_timeout_ms?: number
  incremental?: boolean
  skip_drafts?: boolean
  language?: string
  fail_on_severity?: 'none' | 'medium' | 'high'
  summary_only?: boolean
  custom_instructions?: string
  agent_max_iterations?: number
  agent_max_tool_calls?: number
  agent_token_budget?: number
  agent_allow_suggestions?: boolean
  agent_web_search?: boolean
  agent_web_search_max_calls?: number
  agent_filter_model?: string
  auto_threshold_files?: number
  dry_run?: boolean
  debug?: boolean
}

function trimmedInput (name: string): string {
  return core.getInput(name).trim()
}

function multilineInput (name: string): string[] {
  return core.getMultilineInput(name)
}

function optionalNumberInput (name: string): number | undefined {
  const raw = trimmedInput(name)
  if (raw === '') return undefined
  const value = Number(raw)
  if (Number.isNaN(value)) {
    throw new ConfigError(`Input \`${name}\` must be a number, got "${raw}".`)
  }
  return value
}

const TRUE_VALUES = new Set(['true', 'True', 'TRUE'])
const FALSE_VALUES = new Set(['false', 'False', 'FALSE'])

/**
 * Parses a YAML 1.2 "core schema" boolean, matching `core.getBooleanInput`'s
 * accepted values -- but, unlike `core.getBooleanInput`, treats `''` as
 * "not provided" (returns `undefined`) instead of throwing.
 */
function optionalBooleanInput (name: string): boolean | undefined {
  const raw = trimmedInput(name)
  if (raw === '') return undefined
  if (TRUE_VALUES.has(raw)) return true
  if (FALSE_VALUES.has(raw)) return false
  throw new ConfigError(
    `Input \`${name}\` must be a boolean ("true"/"false"), got "${raw}".`,
    'Supported boolean values: true | True | TRUE | false | False | FALSE.'
  )
}

function normalizeBaseUrl (url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Header names that plausibly carry a credential. Deliberately name-based,
 * not value-based: masking every header value regardless of its name (the
 * pre-fix behavior) corrupted unrelated log/comment text whenever a
 * non-secret value happened to match, e.g. a tenant id shared across
 * headers.
 */
const SECRET_HEADER_NAME_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|api-key|.*[-_](token|secret|key))$/i

/** Parses multiline `Key: Value` headers (FR-4), splitting on the FIRST `:`. */
function parseApiHeaders (name: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of multilineInput(name)) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      logger.warning(`Input \`${name}\`: line "${line}" has no ":" separator, ignoring it.`)
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (!key) {
      logger.warning(`Input \`${name}\`: line "${line}" has an empty header name, ignoring it.`)
      continue
    }
    headers[key] = value
    // An internal gateway's own auth header may carry a secret (PRD §10.3),
    // but only register it when the header NAME itself looks credential-like.
    if (SECRET_HEADER_NAME_PATTERN.test(key)) {
      registerSecret(value)
    }
  }
  return headers
}

/** Reads and normalizes every action input (FR-1..FR-9). Throws `ConfigError` on invalid input. */
export function readInputs (): RawInputs {
  const model = trimmedInput('model')
  if (!model) {
    throw new ConfigError(
      'Input `model` is required.',
      'Pass the provider model name via the `model` workflow input, e.g. `model: gpt-4.1-mini`.'
    )
  }

  const githubToken = trimmedInput('github_token') || process.env.GITHUB_TOKEN || ''
  registerSecret(githubToken)

  const apiKey = trimmedInput('api_key') || process.env.CODE_REVIEW_API_KEY || ''
  registerSecret(apiKey)

  const apiHeaders = parseApiHeaders('api_headers')

  const rawBaseUrl = trimmedInput('api_base_url')

  const result: RawInputs = {
    github_token: githubToken,
    api_key: apiKey,
    api_base_url: rawBaseUrl === '' ? '' : normalizeBaseUrl(rawBaseUrl),
    model,
    api_headers: apiHeaders,
    allow_insecure_base_url: optionalBooleanInput('allow_insecure_base_url') ?? false,
    config_path: trimmedInput('config_path') || DEFAULT_CONFIG_PATH,
    include: multilineInput('include'),
    exclude: multilineInput('exclude'),
    skip_labels: multilineInput('skip_labels')
  }

  const totalTimeoutMs = optionalNumberInput('total_timeout_ms')
  if (totalTimeoutMs !== undefined) result.total_timeout_ms = totalTimeoutMs

  const apiFlavor = trimmedInput('api_flavor')
  if (apiFlavor !== '') result.api_flavor = apiFlavor as 'openai' | 'anthropic' | 'gemini'

  const mode = trimmedInput('mode')
  if (mode !== '') result.mode = mode as 'diff' | 'agent' | 'auto'

  const maxFiles = optionalNumberInput('max_files')
  if (maxFiles !== undefined) result.max_files = maxFiles

  const maxDiffBytes = optionalNumberInput('max_diff_bytes')
  if (maxDiffBytes !== undefined) result.max_diff_bytes = maxDiffBytes

  const maxComments = optionalNumberInput('max_comments')
  if (maxComments !== undefined) result.max_comments = maxComments

  const maxOutputTokens = optionalNumberInput('max_output_tokens')
  if (maxOutputTokens !== undefined) result.max_output_tokens = maxOutputTokens

  const maxModelCalls = optionalNumberInput('max_model_calls')
  if (maxModelCalls !== undefined) result.max_model_calls = maxModelCalls

  const contextWindow = optionalNumberInput('context_window')
  if (contextWindow !== undefined) result.context_window = contextWindow

  const temperature = optionalNumberInput('temperature')
  if (temperature !== undefined) result.temperature = temperature

  const requestTimeoutMs = optionalNumberInput('request_timeout_ms')
  if (requestTimeoutMs !== undefined) result.request_timeout_ms = requestTimeoutMs

  const incremental = optionalBooleanInput('incremental')
  if (incremental !== undefined) result.incremental = incremental

  const skipDrafts = optionalBooleanInput('skip_drafts')
  if (skipDrafts !== undefined) result.skip_drafts = skipDrafts

  const language = trimmedInput('language')
  if (language !== '') result.language = language

  const failOnSeverity = trimmedInput('fail_on_severity')
  if (failOnSeverity !== '') result.fail_on_severity = failOnSeverity as 'none' | 'medium' | 'high'

  const summaryOnly = optionalBooleanInput('summary_only')
  if (summaryOnly !== undefined) result.summary_only = summaryOnly

  const customInstructions = trimmedInput('custom_instructions')
  if (customInstructions !== '') result.custom_instructions = customInstructions

  const agentMaxIterations = optionalNumberInput('agent_max_iterations')
  if (agentMaxIterations !== undefined) result.agent_max_iterations = agentMaxIterations

  const agentMaxToolCalls = optionalNumberInput('agent_max_tool_calls')
  if (agentMaxToolCalls !== undefined) result.agent_max_tool_calls = agentMaxToolCalls

  const agentTokenBudget = optionalNumberInput('agent_token_budget')
  if (agentTokenBudget !== undefined) result.agent_token_budget = agentTokenBudget

  const agentAllowSuggestions = optionalBooleanInput('agent_allow_suggestions')
  if (agentAllowSuggestions !== undefined) result.agent_allow_suggestions = agentAllowSuggestions

  const agentWebSearch = optionalBooleanInput('agent_web_search')
  if (agentWebSearch !== undefined) result.agent_web_search = agentWebSearch

  const agentWebSearchMaxCalls = optionalNumberInput('agent_web_search_max_calls')
  if (agentWebSearchMaxCalls !== undefined) result.agent_web_search_max_calls = agentWebSearchMaxCalls

  const agentFilterModel = trimmedInput('agent_filter_model')
  if (agentFilterModel !== '') result.agent_filter_model = agentFilterModel

  const autoThresholdFiles = optionalNumberInput('auto_threshold_files')
  if (autoThresholdFiles !== undefined) result.auto_threshold_files = autoThresholdFiles

  const dryRun = optionalBooleanInput('dry_run')
  if (dryRun !== undefined) result.dry_run = dryRun

  const debugFlag = optionalBooleanInput('debug')
  if (debugFlag !== undefined) result.debug = debugFlag

  return result
}
