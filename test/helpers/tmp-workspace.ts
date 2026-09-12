import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Real, disposable directory tree for `engine/tools/**` tests (sandbox,
 * read-file, list-files, grep) — these need actual filesystem behaviour
 * (symlinks, binary bytes, large files) that a fixture checked into
 * `test/fixtures/` can't express as cleanly as a per-test temp dir. Always
 * cleaned up, even when `fn` throws.
 */
export interface TmpWorkspace {
  root: string
  write(relPath: string, content: string | Uint8Array): Promise<void>
  symlink(target: string, relPath: string): Promise<void>
}

export async function withTmpWorkspace<T> (fn: (ws: TmpWorkspace) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'acr-test-'))
  const ws: TmpWorkspace = {
    root,
    async write (relPath, content) {
      const abs = path.join(root, relPath)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content)
    },
    async symlink (target, relPath) {
      const abs = path.join(root, relPath)
      await mkdir(path.dirname(abs), { recursive: true })
      await symlink(target, abs)
    }
  }
  try {
    return await fn(ws)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
