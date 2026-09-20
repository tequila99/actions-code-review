/**
 * Pure validation/normalization for a single model-produced finding (FR-33/
 * FR-34). Kept separate from `engine/diff-engine.ts` (which calls this once
 * per element of the model's `findings` array) so the same logic can be
 * reused, unmodified, by `AgentEngine` (stage 7), where findings arrive one
 * at a time through the `post_comment` tool call rather than as a batch.
 */

import type { Finding } from '../engine/types.ts'

const VALID_SEVERITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'info'])

export type FindingValidationResult =
  { ok: true; finding: Finding; warning?: string } | { ok: false; reason: string }

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shared by both engines for the "the model returned no summary text" case. */
export function defaultSummary (findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No issues found.'
  return `Found ${findings.length} issue(s) across the reviewed files.`
}

/** True for text `defaultSummary` can produce — an engine-generated placeholder, not the model's own words. */
export function isDefaultSummary (text: string): boolean {
  return text === defaultSummary([]) || /^Found \d+ issue\(s\) across the reviewed files\.$/.test(text)
}

/**
 * Validates and normalizes one raw finding object against `validPaths` (the
 * set of file paths that were actually part of the batch sent to the model —
 * a finding referencing anything else cannot be trusted, T4.23).
 *
 * Rules (T4.22-T4.26):
 * - `path` missing, non-string, or not in `validPaths` -> dropped.
 * - `line` missing, non-integer, `<= 0` -> dropped.
 * - `message` missing/blank -> dropped.
 * - `severity` missing or not one of high/medium/low/info -> normalized to
 *   `'info'`, with a `warning` describing the normalization (caller logs it).
 * - `category` missing/blank -> normalized to `'general'` (not a drop
 *   condition — the plan only requires a warning-and-drop for `severity`,
 *   `line`, `path`, `message`; `category` has no such rule, so a sane
 *   fallback is used instead of rejecting an otherwise-good finding).
 */
export function normalizeAndValidateFinding (
  raw: unknown,
  validPaths: ReadonlySet<string>
): FindingValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'finding is not a JSON object' }
  }

  const path = typeof raw.path === 'string' ? raw.path : null
  if (path === null || path === '') {
    return {
      ok: false,
      reason: `finding has a missing/invalid "path": ${JSON.stringify(raw.path)}`
    }
  }
  if (!validPaths.has(path)) {
    return { ok: false, reason: `finding references a path outside this batch: "${path}"` }
  }

  const line = raw.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
    return {
      ok: false,
      reason: `finding for "${path}" has an invalid "line": ${JSON.stringify(line)}`
    }
  }

  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (message === '') {
    return { ok: false, reason: `finding for "${path}:${line}" is missing a "message"` }
  }

  let severity: Finding['severity']
  let warning: string | undefined
  const rawSeverity = raw.severity
  if (typeof rawSeverity === 'string' && VALID_SEVERITIES.has(rawSeverity)) {
    severity = rawSeverity as Finding['severity']
  } else {
    severity = 'info'
    warning = `finding for "${path}:${line}" has an unknown severity ${JSON.stringify(rawSeverity)}, normalized to "info"`
  }

  const category =
    typeof raw.category === 'string' && raw.category.trim() !== '' ? raw.category.trim() : 'general'

  const finding: Finding = { path, line, severity, category, message }

  const endLine = raw.end_line
  if (typeof endLine === 'number' && Number.isInteger(endLine) && endLine > 0) {
    finding.endLine = endLine
  }

  return warning !== undefined ? { ok: true, finding, warning } : { ok: true, finding }
}

/**
 * Convenience batch wrapper around `normalizeAndValidateFinding`: validates
 * every element of `rawFindings`, invoking `onWarning`/`onDrop` for the
 * caller's logging (`diff-engine.ts` forwards these to `logger.warning`) and
 * returning only the findings that passed.
 */
export function normalizeFindings (
  rawFindings: readonly unknown[],
  validPaths: ReadonlySet<string>,
  hooks: { onWarning?: (message: string) => void; onDrop?: (reason: string) => void } = {}
): Finding[] {
  const findings: Finding[] = []
  for (const raw of rawFindings) {
    const result = normalizeAndValidateFinding(raw, validPaths)
    if (result.ok) {
      findings.push(result.finding)
      if (result.warning) hooks.onWarning?.(result.warning)
    } else {
      hooks.onDrop?.(result.reason)
    }
  }
  return findings
}
