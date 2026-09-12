/**
 * Path resolution for every `AgentEngine` tool (FR-47, THR-5, THR-6). Every
 * tool that touches the filesystem (`read_file`/`list_files`/`grep`) goes
 * through `resolveSandboxPath` first — never `path.resolve`/`fs.*` directly
 * on a model-supplied path. The deny-list (`isDenyListed`) has no
 * configuration surface at all (no parameter accepts an override), which is
 * what makes it non-overridable by user config (T7.10) — there is simply
 * nothing a config file could pass in to change it.
 */

import { realpath } from 'node:fs/promises'
import path from 'node:path'

export interface SandboxOk {
  ok: true
  absolutePath: string
}

export interface SandboxErr {
  ok: false
  reason: string
}

export type SandboxResult = SandboxOk | SandboxErr

const DENY_SEGMENT_PATTERNS: readonly RegExp[] = [/^\.git$/]

const DENY_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^credentials/i
]

function isDenyListed (normalizedRelPath: string): boolean {
  const segments = normalizedRelPath.split('/')
  if (segments.some((segment) => DENY_SEGMENT_PATTERNS.some((p) => p.test(segment)))) return true
  const basename = segments[segments.length - 1] ?? ''
  return DENY_BASENAME_PATTERNS.some((p) => p.test(basename))
}

function containsBackslash (value: string): boolean {
  return value.includes('\\')
}

/**
 * Resolves a model-supplied `path` argument against `workspaceRoot`,
 * rejecting anything that would read outside it. Never throws — every
 * failure mode (THR-5/THR-6, malformed input) is a `{ok: false}` result so
 * calling tools can turn it into a tool-result error the model sees and can
 * recover from (T7.16-style "result-error, not exception").
 */
export async function resolveSandboxPath (
  rawPath: unknown,
  workspaceRoot: string
): Promise<SandboxResult> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { ok: false, reason: 'path must be a non-empty string' }
  }
  if (rawPath.includes('\0')) {
    return { ok: false, reason: 'path must not contain a NUL byte' }
  }
  if (containsBackslash(rawPath)) {
    return { ok: false, reason: 'path must use forward slashes' }
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { ok: false, reason: 'path has malformed percent-encoding' }
  }
  if (containsBackslash(decoded)) {
    return { ok: false, reason: 'path must use forward slashes' }
  }
  if (decoded.startsWith('~')) {
    return { ok: false, reason: 'home-directory paths are not allowed' }
  }
  if (path.posix.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) {
    return { ok: false, reason: 'absolute paths are not allowed' }
  }

  const normalized = path.posix.normalize(decoded)
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, reason: 'path escapes the repository workspace' }
  }

  const resolvedRoot = path.resolve(workspaceRoot)
  const absolutePath = path.resolve(resolvedRoot, normalized)
  const rootPrefix = resolvedRoot + path.sep
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(rootPrefix)) {
    return { ok: false, reason: 'path escapes the repository workspace' }
  }

  if (isDenyListed(normalized)) {
    return { ok: false, reason: 'access to this path is denied by policy' }
  }

  try {
    const realPath = await realpath(absolutePath)
    const realRoot = await realpath(resolvedRoot)
    const realRootPrefix = realRoot + path.sep
    if (realPath !== realRoot && !realPath.startsWith(realRootPrefix)) {
      return { ok: false, reason: 'path resolves outside the repository workspace' }
    }
  } catch {
    // Doesn't exist yet (or a broken symlink) — not sandbox's concern; the
    // calling tool (e.g. read_file) surfaces its own not-found error.
  }

  return { ok: true, absolutePath }
}
