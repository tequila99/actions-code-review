import type { ResolvedConfig } from '../../src/config/schema.ts'

/**
 * Builds a minimal, valid `ResolvedConfig` for `engine/**` tests, which need
 * the full merged shape (`ResolvedConfig`) rather than the raw
 * inputs/file/defaults `merge.ts` combines to produce it. Deep-overridable
 * per top-level section (`overrides.review`, `overrides.context`, ...) so a
 * test only has to spell out the fields it actually varies.
 */
export function makeResolvedConfig (
  overrides: {
    [K in keyof ResolvedConfig]?: ResolvedConfig[K] extends object
      ? Partial<ResolvedConfig[K]>
      : ResolvedConfig[K]
  } = {}
): ResolvedConfig {
  return {
    version: 1,
    mode: 'diff',
    model: 'gpt-4o-mini',
    github_token: 'ghp_test_token_1234567890',
    config_path: '.github/code-review.yml',
    ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.github_token !== undefined ? { github_token: overrides.github_token } : {}),
    ...(overrides.config_path !== undefined ? { config_path: overrides.config_path } : {}),
    api: {
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test-key-1234567890',
      flavor: 'openai',
      context_window: 128000,
      request_timeout_ms: 120000,
      total_timeout_ms: 900000,
      headers: {},
      allow_insecure_base_url: false,
      ...overrides.api
    },
    filters: {
      include: [],
      exclude: [],
      max_files: 50,
      max_diff_bytes: 400000,
      skip_drafts: true,
      skip_labels: [],
      context_lines: 3,
      ...overrides.filters
    },
    review: {
      language: 'en',
      max_comments: 25,
      max_output_tokens: 4000,
      max_model_calls: 3,
      fail_on_severity: 'none',
      summary_only: false,
      custom_instructions: '',
      focus: [],
      ignore: [],
      path_instructions: [],
      ...overrides.review
    },
    context: {
      always: [],
      layers: [],
      max_context_bytes: 60000,
      ...overrides.context
    },
    agent: {
      max_iterations: 20,
      max_tool_calls: 60,
      token_budget: 300000,
      tool_output_max_bytes: 32768,
      allow_suggestions: true,
      tools: [],
      web_search: { enabled: false, max_calls: 4 },
      filter_model: '',
      ...overrides.agent
    },
    budget: {
      ...overrides.budget
    },
    incremental: true,
    auto_threshold_files: 8,
    dry_run: false,
    debug: false,
    ...(overrides.incremental !== undefined ? { incremental: overrides.incremental } : {}),
    ...(overrides.auto_threshold_files !== undefined
      ? { auto_threshold_files: overrides.auto_threshold_files }
      : {}),
    ...(overrides.dry_run !== undefined ? { dry_run: overrides.dry_run } : {}),
    ...(overrides.debug !== undefined ? { debug: overrides.debug } : {})
  }
}
