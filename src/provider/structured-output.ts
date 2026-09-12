import { ProviderError } from '../util/errors.ts'
import { HttpStatusError } from './retry.ts'
import type { CompletionRequest, CompletionResponse, JsonSchema } from './types.ts'

/**
 * The three rungs of the FR-21 degradation ladder. `'json_schema'` and
 * `'json_object'` map 1:1 to OpenAI-compatible `response_format.type`
 * values; `'none'` means no `response_format` is sent at all and the schema
 * is instead described in the prompt text, relying on the tolerant parser
 * below (`extractJson`) to pull the JSON back out of free-form text.
 */
export type StructuredOutputStage = 'json_schema' | 'json_object' | 'none'

export type MaxOutputTokensParam = 'max_tokens' | 'max_completion_tokens'

export interface StructuredAttemptParams {
  responseFormatStage: StructuredOutputStage
  maxOutputTokensParam: MaxOutputTokensParam
  /** True once a prior attempt returned unparsable JSON (T3.41) — the caller
   * should append a stricter "return ONLY valid JSON" instruction. */
  strictJsonInstruction: boolean
}

/**
 * A single HTTP attempt, as wired up by `openai-compatible.ts`: builds the
 * request body according to `params`, sends it through `retry.ts` (which
 * transparently retries 408/429/5xx/network errors and rethrows anything
 * else, including 400, unmodified), and resolves/rejects with exactly one
 * *logical* outcome for this rung of the ladder.
 */
export type StructuredAttempt = (params: StructuredAttemptParams) => Promise<CompletionResponse>

export interface StructuredCompleteResult {
  response: CompletionResponse
  stage: StructuredOutputStage
}

const MAX_LADDER_ITERATIONS = 8

function errorText (err: unknown): string {
  if (err instanceof HttpStatusError) return `${err.bodyText ?? ''} ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

function mentions (text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * FR-21a in isolation: given the output-token-limit parameter name that was
 * just rejected (`current`) and the 400 error body/message, decides whether
 * to swap to the other name. Returns `null` when the error text doesn't
 * mention the current parameter name at all (nothing to swap). Exported
 * (small, pure) so both directions of the swap can be tested directly
 * without having to first force the ladder into a `max_completion_tokens`
 * starting state through the public `completeStructured` entry point.
 */
export function swappedMaxOutputTokensParam (
  current: MaxOutputTokensParam,
  errorText: string
): MaxOutputTokensParam | null {
  if (current === 'max_tokens' && mentions(errorText, 'max_tokens')) return 'max_completion_tokens'
  if (current === 'max_completion_tokens' && mentions(errorText, 'max_completion_tokens')) {
    return 'max_tokens'
  }
  return null
}

/**
 * Owns the entire FR-21/FR-21a degradation ladder and the FR-34 tolerant
 * JSON parser — this is the ONLY module that interprets an HTTP 400 (§7.1
 * PRD). `retry.ts`, one layer below, never looks at 400 at all.
 *
 * Ladder, in order, each triggered by a fresh 400 whose body mentions the
 * relevant thing:
 *   1. `json_schema` -> (400 mentions response_format/json_schema) -> `json_object`
 *   2. `json_object`  -> (400 mentions response_format/json_schema) -> `none` (schema-in-prompt)
 *   3. at any stage, a 400 mentioning `max_tokens`/`max_completion_tokens`
 *      swaps that request parameter's name once (FR-21a), independent of
 *      the response-format stage.
 *   4. once an HTTP-successful response comes back and a `responseSchema`
 *      was requested, its `text` is run through the tolerant JSON parser;
 *      on failure, exactly one more attempt is made with
 *      `strictJsonInstruction: true` before giving up (T3.41, R-1).
 */
export async function completeStructured (
  req: CompletionRequest,
  attempt: StructuredAttempt
): Promise<StructuredCompleteResult> {
  let stage: StructuredOutputStage = req.responseSchema ? 'json_schema' : 'none'
  let maxOutputTokensParam: MaxOutputTokensParam = 'max_tokens'
  let triedParamSwitch = false
  let strictJsonInstruction = false
  let jsonRetried = false

  for (let iteration = 0; iteration < MAX_LADDER_ITERATIONS; iteration++) {
    let response: CompletionResponse
    try {
      response = await attempt({
        responseFormatStage: stage,
        maxOutputTokensParam,
        strictJsonInstruction
      })
    } catch (err) {
      if (!(err instanceof HttpStatusError) || err.status !== 400) throw err
      const text = errorText(err)

      if (!triedParamSwitch) {
        const swapped = swappedMaxOutputTokensParam(maxOutputTokensParam, text)
        if (swapped) {
          maxOutputTokensParam = swapped
          triedParamSwitch = true
          continue
        }
      }
      if (
        stage === 'json_schema' &&
        (mentions(text, 'response_format') || mentions(text, 'json_schema'))
      ) {
        stage = 'json_object'
        continue
      }
      if (
        stage === 'json_object' &&
        (mentions(text, 'response_format') || mentions(text, 'json_schema'))
      ) {
        stage = 'none'
        continue
      }
      throw err
    }

    if (!req.responseSchema) {
      return { response, stage }
    }

    try {
      extractJson(response.text ?? '')
      return { response, stage }
    } catch {
      if (jsonRetried) {
        throw new ProviderError(
          'Model did not return valid JSON matching the requested schema, even after a stricter retry.',
          'Check that the model actually supports structured/JSON output for this request size.'
        )
      }
      jsonRetried = true
      strictJsonInstruction = true
    }
  }

  throw new ProviderError(
    'Structured-output degradation ladder exhausted without a usable response.'
  )
}

// ---------------------------------------------------------------------------
// FR-34: tolerant JSON extraction.
// ---------------------------------------------------------------------------

const MARKDOWN_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i

/**
 * Extracts a JSON value from arbitrary model output text: a bare JSON
 * document, one wrapped in a ```json fenced code block, or one surrounded
 * by preamble/trailing prose. Throws `ProviderError` if no valid JSON value
 * can be found by any of these strategies.
 */
export function extractJson (text: string): unknown {
  const trimmed = text.trim()

  const direct = tryParse(trimmed)
  if (direct.ok) return direct.value

  const fenceMatch = MARKDOWN_FENCE_RE.exec(trimmed)
  if (fenceMatch) {
    const fenced = tryParse((fenceMatch[1] ?? '').trim())
    if (fenced.ok) return fenced.value
  }

  const extracted = extractFirstJsonValue(trimmed)
  if (extracted !== undefined) {
    const parsed = tryParse(extracted)
    if (parsed.ok) return parsed.value
  }

  throw new ProviderError('Model response did not contain a parsable JSON value.')
}

function tryParse (text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** Finds the first balanced `{...}`/`[...]` value in `text`, tolerant of
 * preceding preamble and trailing text (string-literal-aware brace counting). */
function extractFirstJsonValue (text: string): string | undefined {
  const startIdx = text.search(/[{[]/)
  if (startIdx === -1) return undefined
  const openChar = text[startIdx]
  const closeChar = openChar === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escapeNext) escapeNext = false
      else if (ch === '\\') escapeNext = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === openChar) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// §11.4: conservative JSON Schema sent to the model.
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'additionalProperties'
])

/**
 * Strips a `responseSchema` down to the conservative subset every
 * self-hosted/gateway platform is expected to understand (§11.4 PRD): only
 * `type`/`properties`/`required`/`items`/`enum`/`description`, recursively.
 * In particular this guarantees `oneOf`/`allOf`/`$ref`/`pattern` (and
 * anything else) never reach the provider (T3.42).
 */
export function sanitizeJsonSchema (schema: JsonSchema): JsonSchema {
  const result: JsonSchema = {}
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue
    const value = schema[key]
    // `additionalProperties: true` (or any non-boolean-false value) would defeat the
    // whole point of an allowlisted schema by letting the model attach arbitrary
    // extra fields — only the strict-mode-required `false` is ever forwarded.
    if (key === 'additionalProperties') {
      if (value === false) result[key] = false
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const props: Record<string, unknown> = {}
      for (const [propKey, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] =
          propSchema !== null && typeof propSchema === 'object'
            ? sanitizeJsonSchema(propSchema as JsonSchema)
            : propSchema
      }
      result[key] = props
    } else if (key === 'items' && value !== null && typeof value === 'object') {
      result[key] = sanitizeJsonSchema(value as JsonSchema)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Converts a (typically already-sanitized) JSON Schema to the shape OpenAI's
 * `strict: true` structured-output mode requires (issue #9): every object
 * node must set `additionalProperties: false` and list *every* key of its
 * `properties` in `required` — OpenAI's strict mode has no notion of an
 * optional property. A field that was genuinely optional in the source
 * schema is preserved as such by widening its `type` to include `'null'`
 * instead (`type: 'string'` -> `type: ['string', 'null']`), so the model can
 * satisfy the now-mandatory key by emitting `null`.
 *
 * Only applied on the `json_schema`-stage request body
 * (`openai-compatible.ts#buildRequestBody`) — the `json_object`/`none`
 * stages describe the schema as plain prompt text instead (`buildSystemContent`)
 * and deliberately keep it non-strict there: a model without native strict-mode
 * support has no way to interpret a `[T, 'null']` union type and would likely
 * just be confused by it.
 */
export function toStrictJsonSchema (schema: JsonSchema): JsonSchema {
  const result: JsonSchema = { ...schema }

  if (result.type === 'object' && result.properties !== null && typeof result.properties === 'object') {
    const originalRequired = new Set(
      Array.isArray(result.required) ? (result.required as unknown[]) : []
    )
    const props = result.properties as Record<string, JsonSchema>
    const strictProps: Record<string, JsonSchema> = {}
    for (const [key, propSchema] of Object.entries(props)) {
      const strictProp =
        propSchema !== null && typeof propSchema === 'object'
          ? toStrictJsonSchema(propSchema)
          : propSchema
      strictProps[key] = originalRequired.has(key) ? strictProp : withNullableType(strictProp)
    }
    result.properties = strictProps
    result.required = Object.keys(props)
    result.additionalProperties = false
  }

  if (result.items !== null && typeof result.items === 'object') {
    result.items = toStrictJsonSchema(result.items as JsonSchema)
  }

  return result
}

/** Widens `schema.type` to include `'null'`, tolerating both the single-string
 * and already-array forms and never adding `'null'` twice. */
function withNullableType (schema: JsonSchema): JsonSchema {
  const type = schema.type
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] }
  }
  if (typeof type === 'string' && type !== 'null') {
    return { ...schema, type: [type, 'null'] }
  }
  return schema
}
