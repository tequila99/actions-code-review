/**
 * Shared glob matching for `grep`/`list_files` (FR-43/FR-44). Two deliberate deviations from a
 * raw `minimatch(relativePath, glob)`, both confirmed against a real production trace (x-ai/
 * grok-4.6 on an 84-file monorepo PR):
 *
 * 1. A glob with no `/` in it also matches on the *basename*, at any depth. Models write `*.ts`
 *    meaning "any TypeScript file", not "a TypeScript file sitting at the repository root" —
 *    `minimatch`'s `*` never crosses a `/`, so in that trace `grep(..., glob: "*.{ts,vue}")`
 *    returned "(no matches)" against a repo of almost nothing but `.ts`/`.vue` files. The model
 *    called the result "странно" in its own reasoning and fell back to reading files one at a
 *    time, which is what eventually exhausted its tool-call budget. Every agentic file-search
 *    tool models are trained against reads a bare `*.ts` the basename way.
 * 2. `dot: true`, so a glob can reach into dot-directories: `.github/workflows/*.yaml` is
 *    ordinary PR content, and by default `minimatch` refuses to let `*`/`**` match a path
 *    segment starting with `.`.
 */

import { minimatch } from 'minimatch'

const OPTIONS = { dot: true }

/** `relativePath` is always workspace-relative with `/` separators (see `walk.ts`). */
export function matchesGlob (relativePath: string, glob: string): boolean {
  if (minimatch(relativePath, glob, OPTIONS)) return true
  if (glob.includes('/')) return false
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return minimatch(basename, glob, OPTIONS)
}
