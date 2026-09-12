import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigError } from '../util/errors.ts'
import { parseFileConfig, type FileConfig } from './schema.ts'

/**
 * Root directory config paths are resolved against. `GITHUB_WORKSPACE` is
 * what the Actions runner sets for a real run; `process.cwd()` is the
 * fallback used outside a runner (local dev, unit tests without the env var).
 */
export function workspaceRoot (): string {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

/**
 * Reads and validates `.github/code-review.yml` (or wherever `configPath`
 * points, relative to the workspace root). A missing file, an empty file,
 * or a file containing only comments are all treated as "no config"
 * (`{}`) rather than an error (FR-5/FR-9).
 */
export async function readFileConfig (configPath: string): Promise<FileConfig> {
  const resolvedPath = path.resolve(workspaceRoot(), configPath)

  let raw: string
  try {
    raw = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === 'ENOENT') {
      return {}
    }
    throw new ConfigError(`Failed to read config file "${configPath}": ${nodeError.message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    throw new ConfigError(
      `Invalid YAML in config file "${configPath}": ${(error as Error).message}`
    )
  }

  if (parsed === null || parsed === undefined) {
    return {}
  }

  return parseFileConfig(parsed)
}
