import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { DEFAULTS } from '../src/config/defaults.ts'

/**
 * T6.1-T6.9 (IMPLEMENTATION_PLAN.md "Этап 6"): document-vs-code consistency
 * checks for `action.yml`. These tests never call `readInputs()`/`run()` —
 * they cross-reference the *text* of `action.yml` and `src/config/inputs.ts`
 * so a future edit to either file that forgets the other is caught here.
 */

const ROOT = path.resolve(import.meta.dirname, '..')

async function loadActionYml (): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(ROOT, 'action.yml'), 'utf8')
  return parseYaml(raw) as Record<string, unknown>
}

async function loadInputsSource (): Promise<string> {
  return readFile(path.join(ROOT, 'src/config/inputs.ts'), 'utf8')
}

interface ActionYmlInput {
  description?: string
  required?: boolean
  default?: string
}

/** §8.2 PRD, verbatim — the 14 outputs, independent of `main.ts#OUTPUT_KEYS`
 * so this test can also catch a drift in `main.ts` itself (T6.5). */
const PRD_OUTPUTS = [
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
]

test('T6.1: action.yml parses as YAML', async () => {
  const doc = await loadActionYml()
  assert.equal(typeof doc, 'object')
  assert.ok(doc.inputs)
  assert.ok(doc.outputs)
  assert.ok(doc.runs)
})

test('T6.2: every action.yml input is read somewhere in src/config/inputs.ts', async () => {
  const doc = await loadActionYml()
  const inputsSource = await loadInputsSource()
  const inputKeys = Object.keys(doc.inputs as Record<string, unknown>)
  assert.ok(inputKeys.length > 0)

  for (const key of inputKeys) {
    assert.ok(
      inputsSource.includes(`'${key}'`),
      `input "${key}" from action.yml is never read (no \`'${key}'\` literal) in src/config/inputs.ts`
    )
  }
})

test('T6.3: every input literal read in src/config/inputs.ts is declared in action.yml', async () => {
  const doc = await loadActionYml()
  const inputsSource = await loadInputsSource()
  const declaredKeys = new Set(Object.keys(doc.inputs as Record<string, unknown>))

  // Every `core.getInput('x')` / `core.getMultilineInput('x')` /
  // `optionalNumberInput('x')` / `optionalBooleanInput('x')` /
  // `trimmedInput('x')` / `multilineInput('x')` call site.
  const callPattern =
    /\b(?:core\.getInput|core\.getMultilineInput|trimmedInput|multilineInput|optionalNumberInput|optionalBooleanInput)\('([a-z0-9_]+)'\)/g
  const readKeys = new Set<string>()
  for (const match of inputsSource.matchAll(callPattern)) {
    readKeys.add(match[1]!)
  }
  assert.ok(readKeys.size > 0, 'sanity check: at least one input read call should be found')

  for (const key of readKeys) {
    assert.ok(declaredKeys.has(key), `"${key}" is read by inputs.ts but not declared in action.yml`)
  }
})

test('T6.4: action.yml defaults match src/config/defaults.ts DEFAULTS for every overlapping key', async () => {
  const doc = await loadActionYml()
  const inputs = doc.inputs as Record<string, ActionYmlInput>

  // Map of action.yml input name -> DEFAULTS key (identical names except
  // where DEFAULTS has no `github_token`/`api_key`/`config_path`/etc. entry
  // at all — those are intentionally excluded, they have no single scalar
  // "default" that lives in DEFAULTS, e.g. github_token defaults to a GitHub
  // expression, not a DEFAULTS constant).
  //
  // `language` IS present in DEFAULTS (`'en'`, still the fallback used by
  // `config/language.ts#resolveReviewLanguage` when auto-detect isn't
  // confident) but is intentionally excluded here too: its action.yml
  // default is deliberately `''`, not `'en'`, so an unset input can be told
  // apart from an explicit `'en'` and PR-title auto-detect (Дополнение B,
  // `main.ts`) gets a chance to run at all.
  const DEFAULTS_RECORD: Record<string, unknown> = DEFAULTS
  const EXCLUDED_FROM_DEFAULT_COMPARISON = new Set(['language'])
  const comparable = Object.keys(inputs).filter(
    (key) => key in DEFAULTS_RECORD && !EXCLUDED_FROM_DEFAULT_COMPARISON.has(key)
  )
  assert.ok(comparable.length > 0, 'sanity check: at least one input should overlap with DEFAULTS')

  for (const key of comparable) {
    const actionDefault = inputs[key]!.default
    const expected = DEFAULTS_RECORD[key]
    // action.yml defaults are always strings (GitHub Actions input default
    // type); compare against the stringified DEFAULTS value.
    assert.equal(
      actionDefault,
      String(expected),
      `action.yml default for "${key}" ("${actionDefault}") does not match DEFAULTS.${key} ("${expected}")`
    )
  }
})

test('TB.16: action.yml `language` input defaults to "" (empty), enabling PR-title auto-detect', async () => {
  const doc = await loadActionYml()
  const inputs = doc.inputs as Record<string, ActionYmlInput>
  assert.equal(inputs.language!.default, '')
})

test('T6.5: action.yml outputs are exactly the 14 outputs from PRD §8.2', async () => {
  const doc = await loadActionYml()
  const outputKeys = Object.keys(doc.outputs as Record<string, unknown>).sort()
  assert.deepEqual(outputKeys, [...PRD_OUTPUTS].sort())
})

test('T6.6: runs.using is node24', async () => {
  const doc = await loadActionYml()
  const runs = doc.runs as Record<string, unknown>
  assert.equal(runs.using, 'node24')
})

test('T6.7: runs.main is dist/index.js', async () => {
  const doc = await loadActionYml()
  const runs = doc.runs as Record<string, unknown>
  assert.equal(runs.main, 'dist/index.js')
})

test('T6.8: every input has a non-empty description', async () => {
  const doc = await loadActionYml()
  const inputs = doc.inputs as Record<string, ActionYmlInput>
  for (const [key, spec] of Object.entries(inputs)) {
    assert.ok(
      typeof spec.description === 'string' && spec.description.trim().length > 0,
      `input "${key}" is missing a non-empty description`
    )
  }
})

test('T6.9: branding.icon/color are set and valid for the Marketplace', async () => {
  const doc = await loadActionYml()
  const branding = doc.branding as Record<string, unknown>
  assert.equal(typeof branding.icon, 'string')
  assert.ok((branding.icon as string).length > 0)
  assert.equal(typeof branding.color, 'string')
  assert.ok((branding.color as string).length > 0)
  // GitHub Marketplace's allowed branding colors (documented set).
  const ALLOWED_COLORS = [
    'white',
    'yellow',
    'blue',
    'green',
    'orange',
    'red',
    'purple',
    'gray-dark'
  ]
  assert.ok(
    ALLOWED_COLORS.includes(branding.color as string),
    `branding.color "${branding.color}" is not one of the Marketplace-allowed colors`
  )
})

test('T6 (model is required, no default)', async () => {
  const doc = await loadActionYml()
  const inputs = doc.inputs as Record<string, ActionYmlInput>
  assert.equal(inputs.model!.required, true)
  assert.equal(inputs.model!.default, undefined)
})

/**
 * T6.10: README.md states the input/output counts as prose ("every input
 * (N total)" / "the N outputs this action produces") rather than deriving
 * them from action.yml, so the two can silently drift apart whenever an
 * input or output is added/removed. Cross-check the numbers here instead of
 * only trusting the prose.
 */
test('T6.10: README.md input/output counts match the actual counts in action.yml', async () => {
  const doc = await loadActionYml()
  const actualInputCount = Object.keys(doc.inputs as Record<string, unknown>).length
  const actualOutputCount = Object.keys(doc.outputs as Record<string, unknown>).length

  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8')
  const inputsMatch = readme.match(/every input \((\d+) total\)/)
  const outputsMatch = readme.match(/the (\d+) outputs this action produces/)

  assert.ok(inputsMatch, 'README.md should state the input count as "every input (N total)"')
  assert.ok(
    outputsMatch,
    'README.md should state the output count as "the N outputs this action produces"'
  )

  const documentedInputCount = Number(inputsMatch![1])
  const documentedOutputCount = Number(outputsMatch![1])

  assert.equal(
    documentedInputCount,
    actualInputCount,
    `README.md says ${documentedInputCount} inputs, action.yml has ${actualInputCount}`
  )
  assert.equal(
    documentedOutputCount,
    actualOutputCount,
    `README.md says ${documentedOutputCount} outputs, action.yml has ${actualOutputCount}`
  )
})

test('T6 (author is tequila99, description non-empty)', async () => {
  const doc = await loadActionYml()
  assert.equal(doc.author, 'tequila99')
  assert.equal(typeof doc.description, 'string')
  assert.ok((doc.description as string).length > 0)
})
