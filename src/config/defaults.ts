/**
 * Default `filters.exclude` glob list: lock files, minified assets, source
 * maps, generated/vendor directories, binary/image formats and snapshot
 * files. Always merged in ahead of the file config's and the input's own
 * `exclude` entries (merge.ts) — never replaced.
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/node_modules/**',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.webp',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar.gz',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/__snapshots__/**',
  '**/*.snap'
]

/**
 * Default config file path, relative to the workspace root (`config_path`
 * input default).
 */
export const DEFAULT_CONFIG_PATH = '.github/code-review.yml'

/** Scalar defaults for action inputs and file-only fields. */
export const DEFAULTS = {
  version: 1,
  mode: 'diff',
  api_base_url: 'https://api.openai.com/v1',
  api_flavor: 'openai',
  context_window: 128000,
  request_timeout_ms: 120000,
  total_timeout_ms: 900000,
  allow_insecure_base_url: false,
  max_files: 50,
  max_diff_bytes: 400000,
  max_comments: 25,
  max_output_tokens: 4000,
  max_model_calls: 3,
  context_lines: 6,
  incremental: true,
  skip_drafts: true,
  language: 'en',
  fail_on_severity: 'none',
  summary_only: false,
  custom_instructions: '',
  agent_max_iterations: 20,
  agent_max_tool_calls: 200,
  agent_token_budget: 300000,
  agent_allow_suggestions: true,
  agent_web_search: false,
  agent_web_search_max_calls: 4,
  agent_filter_model: '',
  tool_output_max_bytes: 32768,
  auto_threshold_files: 8,
  dry_run: false,
  debug: false,
  max_context_bytes: 60000
} as const

/** Hard length cap on `review.custom_instructions`, applied post-merge (`merge.ts`) — keeps
 * the system prompt from growing unboundedly on a careless/malicious value. Not a
 * `DEFAULTS` entry: it bounds every source (input and file), it isn't itself a fallback
 * value. */
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 4000
