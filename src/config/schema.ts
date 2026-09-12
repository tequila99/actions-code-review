import { z } from 'zod'
import { ConfigError } from '../util/errors.ts'

// ---------------------------------------------------------------------------
// FR-8: secrets must never live in `.github/code-review.yml`.
// ---------------------------------------------------------------------------

/**
 * Reserved key names (FR-8). Comparison is on the *normalized* key
 * (lowercased, `-` -> `_`) and must be **exact**, never a substring match:
 * `token_budget` / `agent_token_budget` / `github_token_permissions` are
 * legitimate, non-secret field names and must stay valid (T1.56).
 */
export const SECRET_KEY_DENYLIST: ReadonlySet<string> = new Set([
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'authorization',
  'credential',
  'credentials'
])

export function normalizeKeyName (key: string): string {
  return key.toLowerCase().replace(/-/g, '_')
}

/**
 * Recursively walks a raw (untyped) value looking for an object key whose
 * normalized name exactly matches the deny-list. Must run on the *raw*
 * parsed YAML, before any zod parsing: zod's default "strip unknown keys"
 * behaviour on nested `z.object()` schemas would silently drop a
 * disallowed key (e.g. `api.token`) before a `superRefine` on the outer
 * schema ever gets a chance to see it.
 */
export function findSecretKeyPath (value: unknown, path: string[] = []): string[] | null {
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretKeyPath(value[i], [...path, String(i)])
      if (found) return found
    }
    return null
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_DENYLIST.has(normalizeKeyName(key))) {
      return [...path, key]
    }
    const found = findSecretKeyPath(val, [...path, key])
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared enums / fragments
// ---------------------------------------------------------------------------

export const modeEnum = z.enum(['diff', 'agent', 'auto'])
export const apiFlavorEnum = z.enum(['openai', 'anthropic', 'gemini'])
export const severityEnum = z.enum(['none', 'medium', 'high'])

export const pathInstructionSchema = z.object({
  path: z.string().min(1),
  instructions: z.string().min(1)
})
export type PathInstruction = z.infer<typeof pathInstructionSchema>

export const contextLayerSchema = z.object({
  path: z.string().min(1),
  context_files: z.array(z.string()).default([])
})
export type ContextLayer = z.infer<typeof contextLayerSchema>

export const pricingSchema = z.object({
  input_per_1m: z.number().nonnegative(),
  output_per_1m: z.number().nonnegative()
})

// ---------------------------------------------------------------------------
// `.github/code-review.yml` schema (PRD §9) — every field optional, the
// file is allowed to be empty/absent (T1.2, T1.26, T1.29, T1.30).
// ---------------------------------------------------------------------------

export const SUPPORTED_CONFIG_VERSIONS = [1] as const

const apiFileSchema = z.object({
  base_url: z.string().min(1).optional(),
  flavor: apiFlavorEnum.optional(),
  context_window: z.number().int().positive().optional(),
  request_timeout_ms: z.number().int().positive().optional(),
  total_timeout_ms: z.number().int().positive().optional(),
  headers: z.record(z.string(), z.string()).optional()
})

const filtersFileSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  max_files: z.number().int().min(1, 'filters.max_files must be >= 1').optional(),
  max_diff_bytes: z.number().int().min(1).optional(),
  skip_drafts: z.boolean().optional(),
  skip_labels: z.array(z.string()).optional(),
  context_lines: z
    .number()
    .int()
    .min(0, 'filters.context_lines must be between 0 and 30')
    .max(30, 'filters.context_lines must be between 0 and 30')
    .optional()
})

const reviewFileSchema = z.object({
  language: z.string().optional(),
  max_comments: z.number().int().min(1).optional(),
  fail_on_severity: severityEnum.optional(),
  summary_only: z.boolean().optional(),
  custom_instructions: z.string().optional(),
  focus: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  path_instructions: z.array(pathInstructionSchema).optional()
})

const contextFileSchema = z.object({
  always: z.array(z.string()).optional(),
  layers: z.array(contextLayerSchema).optional(),
  max_context_bytes: z.number().int().positive().optional()
})

const webSearchFileSchema = z.object({
  enabled: z.boolean().optional(),
  max_calls: z.number().int().positive().optional()
})

const agentFileSchema = z.object({
  max_iterations: z.number().int().positive().optional(),
  max_tool_calls: z.number().int().positive().optional(),
  token_budget: z.number().int().positive().optional(),
  tool_output_max_bytes: z.number().int().positive().optional(),
  allow_suggestions: z.boolean().optional(),
  tools: z.array(z.string()).optional(),
  web_search: webSearchFileSchema.optional(),
  filter_model: z.string().optional()
})

const budgetFileSchema = z.object({
  max_cost_usd: z.number().nonnegative().optional(),
  pricing: pricingSchema.optional()
})

export const fileConfigSchema = z
  .object({
    version: z.number().optional(),
    mode: modeEnum.optional(),
    model: z.string().min(1).optional(),
    api: apiFileSchema.optional(),
    filters: filtersFileSchema.optional(),
    review: reviewFileSchema.optional(),
    context: contextFileSchema.optional(),
    agent: agentFileSchema.optional(),
    budget: budgetFileSchema.optional()
  })
  .superRefine((data, ctx) => {
    if (
      data.version !== undefined &&
      !(SUPPORTED_CONFIG_VERSIONS as readonly number[]).includes(data.version)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['version'],
        message: `Unsupported config version: ${data.version}. Supported versions: ${SUPPORTED_CONFIG_VERSIONS.join(', ')}.`
      })
    }
  })

export type FileConfig = z.infer<typeof fileConfigSchema>

function formatZodIssues (error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
}

/**
 * Validates a raw, already YAML-parsed value against the config file schema
 * (FR-7). Rejects secrets anywhere in the object (FR-8) before running zod
 * validation, and throws a `ConfigError` with a field-path-qualified message
 * on any failure.
 */
export function parseFileConfig (raw: unknown): FileConfig {
  const secretPath = findSecretKeyPath(raw)
  if (secretPath) {
    throw new ConfigError(
      `Config file must not contain secrets (forbidden key "${secretPath.join('.')}").`,
      'Secrets belong to action inputs (e.g. `api_key`, `github_token`), never to `.github/code-review.yml`.'
    )
  }
  const result = fileConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(formatZodIssues(result.error))
  }
  return result.data
}

// ---------------------------------------------------------------------------
// Resolved config schema — the shape produced by config/merge.ts after
// applying inputs > file > defaults (PRD §9.1). All ambient defaults have
// already been filled in by the time this runs, so most fields are required.
// ---------------------------------------------------------------------------

export const resolvedConfigSchema = z.object({
  version: z.literal(1),
  mode: modeEnum,
  model: z.string().min(1),
  github_token: z.string(),
  config_path: z.string().min(1),
  api: z.object({
    base_url: z.string().min(1),
    api_key: z.string(),
    flavor: apiFlavorEnum,
    context_window: z.number().int().positive(),
    request_timeout_ms: z.number().int().positive(),
    total_timeout_ms: z.number().int().positive(),
    headers: z.record(z.string(), z.string()),
    allow_insecure_base_url: z.boolean(),
    temperature: z.number().optional()
  }),
  filters: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    max_files: z.number().int().min(1),
    max_diff_bytes: z.number().int().min(1),
    skip_drafts: z.boolean(),
    skip_labels: z.array(z.string()),
    context_lines: z.number().int().min(0).max(30)
  }),
  review: z.object({
    language: z.string(),
    max_comments: z.number().int().min(1),
    max_output_tokens: z.number().int().positive(),
    max_model_calls: z.number().int().positive(),
    fail_on_severity: severityEnum,
    summary_only: z.boolean(),
    custom_instructions: z.string(),
    focus: z.array(z.string()),
    ignore: z.array(z.string()),
    path_instructions: z.array(pathInstructionSchema)
  }),
  context: z.object({
    always: z.array(z.string()),
    layers: z.array(contextLayerSchema),
    max_context_bytes: z.number().int().positive()
  }),
  agent: z.object({
    max_iterations: z.number().int().positive(),
    max_tool_calls: z.number().int().positive(),
    token_budget: z.number().int().positive(),
    tool_output_max_bytes: z.number().int().positive(),
    allow_suggestions: z.boolean(),
    tools: z.array(z.string()),
    web_search: z.object({
      enabled: z.boolean(),
      max_calls: z.number().int().positive()
    }),
    /** Дополнение G: `''` (default) disables the noise-filter pass entirely — opt-in,
     * mirrors `web_search`'s off-by-default posture. See `engine/noise-filter.ts`. */
    filter_model: z.string()
  }),
  budget: z.object({
    max_cost_usd: z.number().nonnegative().optional(),
    pricing: pricingSchema.optional()
  }),
  incremental: z.boolean(),
  auto_threshold_files: z.number().int().positive(),
  dry_run: z.boolean(),
  debug: z.boolean()
})

export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>

export function parseResolvedConfig (raw: unknown): ResolvedConfig {
  const result = resolvedConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(formatZodIssues(result.error))
  }
  return result.data
}
