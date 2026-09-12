/**
 * Shared recursive directory walk for `grep`/`list_files` (FR-43/FR-44) —
 * both tools previously carried their own byte-identical `walk()`. Skips
 * known vendor/build/cache directories by name before descending into them,
 * separate from `sandbox.ts`'s deny-list (which is about denying *access*
 * for security, and still applies to everything this returns) — this is
 * purely about not re-walking thousands of `node_modules`/`dist` files on
 * every single tool call. Confirmed against a real agent-mode production
 * trace (gpt-5 via MWS) where a single unfiltered `grep` over a repo with a
 * large `node_modules` tree took 200+ seconds, repeatedly, and the run blew
 * through `total_timeout_ms` before the model ever reached a finding
 * (TO.1-TO.4). `read_file` is unaffected — it resolves a single path
 * directly and never calls this.
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from './sandbox.ts'

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__'
])

export async function walkWorkspace (dir: string, root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const resolved = await resolveSandboxPath(rel, root)
    if (!resolved.ok) continue
    if (entry.isDirectory()) {
      await walkWorkspace(abs, root, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
}
