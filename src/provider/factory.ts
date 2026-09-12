import type { ResolvedConfig } from '../config/schema.ts'
import { ProviderError } from '../util/errors.ts'
import { AnthropicAdapter } from './anthropic.ts'
import { OpenAICompatibleAdapter } from './openai-compatible.ts'
import type { ProviderAdapter } from './types.ts'

const SUPPORTED_FLAVORS = ['openai', 'anthropic', 'gemini'] as const

/**
 * Builds the `ProviderAdapter` for `config.api.flavor`. `'openai'` (FR-20)
 * and `'anthropic'` (FR-27, stage 9a) are implemented; `'gemini'` is
 * recognized-but-not-yet-implemented (stage 9b, FR-28) and gets a clear
 * "not supported yet" error rather than silently falling through to another
 * adapter.
 */
export function createProviderAdapter (config: ResolvedConfig): ProviderAdapter {
  switch (config.api.flavor) {
    case 'openai':
      return new OpenAICompatibleAdapter({
        baseUrl: config.api.base_url,
        apiKey: config.api.api_key,
        model: config.model,
        headers: config.api.headers,
        requestTimeoutMs: config.api.request_timeout_ms
      })
    case 'anthropic':
      return new AnthropicAdapter({
        baseUrl: config.api.base_url,
        apiKey: config.api.api_key,
        model: config.model,
        headers: config.api.headers,
        requestTimeoutMs: config.api.request_timeout_ms
      })
    case 'gemini':
      throw new ProviderError(
        `api.flavor "${config.api.flavor}" is not supported yet (planned for stage 9b).`,
        'Use api.flavor: "openai" (works with vLLM/Ollama/OpenRouter/any OpenAI-compatible gateway) or "anthropic" for now.'
      )
    default: {
      const unknownFlavor: string = config.api.flavor as string
      throw new ProviderError(
        `Unknown api.flavor "${unknownFlavor}".`,
        `Supported values: ${SUPPORTED_FLAVORS.join(', ')}.`
      )
    }
  }
}
