/**
 * Picks the `ReviewEngine` for `config.mode` (T4.36-T4.38, updated stage 7;
 * `mode: 'auto'` implemented stage 8, T8.1-T8.4). `mode: 'agent'` runs the
 * FR-26 capability probe (`capability-probe.ts`) before construction —
 * `provider` and `signal` exist on this signature for exactly that call.
 *
 * `mode: 'auto'` (§7.2, Q-4 `auto_threshold_files`, default 8): files over
 * the threshold go straight to `DiffEngine`, no probe — a PR too big for
 * `AgentEngine` never needed to know whether tool calling works. Files
 * within the threshold reuse the same probe as `mode: 'agent'`, but through
 * `ensureAgentModeSupported`'s `'auto'` branch, which returns `false`
 * instead of throwing on an unsupported model (already logs its own
 * warning) — `mode: auto` degrades silently, `mode: agent` does not.
 */

import type { ResolvedConfig } from '../config/schema.ts'
import type { ProviderAdapter } from '../provider/types.ts'
import { ProviderError } from '../util/errors.ts'
import { logger } from '../util/logger.ts'
import { DiffEngine } from './diff-engine.ts'
import { AgentEngine } from './agent-engine.ts'
import { ensureAgentModeSupported } from '../provider/capability-probe.ts'
import type { ReviewEngine } from './types.ts'

export async function selectEngine (
  config: ResolvedConfig,
  provider: ProviderAdapter,
  signal: AbortSignal,
  fileCount: number
): Promise<ReviewEngine> {
  switch (config.mode) {
    case 'diff':
      return new DiffEngine()
    case 'agent':
      await ensureAgentModeSupported(provider, signal, 'agent')
      return new AgentEngine()
    case 'auto': {
      if (fileCount > config.auto_threshold_files) {
        logger.info(
          `mode: "auto" — ${fileCount} file(s) exceed auto_threshold_files ` +
            `(${config.auto_threshold_files}); using mode: "diff".`
        )
        return new DiffEngine()
      }
      const supported = await ensureAgentModeSupported(provider, signal, 'auto')
      if (supported) {
        logger.info(
          `mode: "auto" — ${fileCount} file(s) within auto_threshold_files ` +
            `(${config.auto_threshold_files}) and tool calling is supported; using mode: "agent".`
        )
        return new AgentEngine()
      }
      // ensureAgentModeSupported already logged the "not supported" warning.
      return new DiffEngine()
    }
    default: {
      const unknownMode: string = config.mode as string
      throw new ProviderError(`Unknown mode "${unknownMode}".`)
    }
  }
}
