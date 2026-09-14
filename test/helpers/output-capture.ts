import type { TestContext } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * `@actions/core#setOutput` writes to the `GITHUB_OUTPUT` file-command file
 * when that env var is set (true for every step in real GitHub Actions) and
 * only falls back to the deprecated `::set-output name=<key>::<value>`
 * stdout command when it is unset (true in a plain local shell, never in
 * CI). A test that only captures stdout therefore passes locally and fails
 * in real CI — `captureStdoutWrites` points `GITHUB_OUTPUT` at a temp file
 * for the duration of the test so `parseSetOutputCommands` can read
 * `setOutput` calls back out either way.
 */
const outputFileByWrites = new WeakMap<string[], string>()

/** Captures `core.setFailed`/`core.setOutput`'s underlying `process.stdout.write` calls. */
export function captureStdoutWrites (t: TestContext): string[] {
  const writes: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })

  const dir = mkdtempSync(path.join(tmpdir(), 'acr-test-'))
  const file = path.join(dir, 'github_output')
  writeFileSync(file, '')
  const previousGithubOutput = process.env.GITHUB_OUTPUT
  process.env.GITHUB_OUTPUT = file
  t.after(() => {
    if (previousGithubOutput === undefined) delete process.env.GITHUB_OUTPUT
    else process.env.GITHUB_OUTPUT = previousGithubOutput
    rmSync(dir, { recursive: true, force: true })
  })
  outputFileByWrites.set(writes, file)

  return writes
}

/** Matches one `key<<delimiter\nvalue\ndelimiter` file-command block (see
 * `@actions/core`'s `prepareKeyValueMessage`). */
const FILE_COMMAND_BLOCK = /^([^\n<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm

/**
 * Parses `core.setOutput` calls out of a `captureStdoutWrites` result —
 * both the deprecated `::set-output::` stdout command and the `GITHUB_OUTPUT`
 * file `captureStdoutWrites` pointed at, so this reads correctly whether or
 * not the file-command protocol was active.
 */
export function parseSetOutputCommands (writes: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /^::set-output name=([^:]+)::(.*)$/
  for (const write of writes) {
    for (const line of write.split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (match) result[match[1]!] = match[2]!
    }
  }

  const file = outputFileByWrites.get(writes)
  if (file !== undefined) {
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(FILE_COMMAND_BLOCK)) {
      result[match[1]!] = match[3]!
    }
  }

  return result
}
