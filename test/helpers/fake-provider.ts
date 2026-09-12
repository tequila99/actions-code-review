import { mock, type Mock } from 'node:test'
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderCapabilities
} from '../../src/provider/types.ts'

/**
 * Fake `ProviderAdapter` for `engine/**` tests (`DiffEngine` never talks to
 * `fetch`/`retry.ts`/`structured-output.ts` directly — it only depends on
 * the `ProviderAdapter` interface). Same shape/rationale as
 * `octokit-mock.ts`: every method is a real `node:test` `mock.fn()` so tests
 * can inspect `.mock.calls`/`.mock.callCount()` and override behaviour with
 * `.mock.mockImplementationOnce(...)`.
 */
export interface FakeProvider extends ProviderAdapter {
  complete: Mock<(req: CompletionRequest) => Promise<CompletionResponse>>
  capabilities: Mock<() => Promise<ProviderCapabilities>>
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  jsonSchema: true,
  jsonObject: true
}

/** Builds a well-formed `CompletionResponse` carrying the given findings-shaped JSON body. */
export function makeCompletionResponse (
  overrides: Partial<CompletionResponse> = {}
): CompletionResponse {
  return {
    text: JSON.stringify({ summary: 'ok', findings: [] }),
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, estimated: false },
    finishReason: 'stop',
    raw: null,
    ...overrides
  }
}

/**
 * Creates a fake `ProviderAdapter`. `completeImpl`, if given, replaces the
 * default "always return an empty-findings success" behaviour — pass a
 * function for per-call custom logic (sequential batches, one failing call,
 * etc.), or leave it unset and override `.mock.mockImplementationOnce(...)`
 * directly on the returned `complete` afterwards.
 */
export function createFakeProvider (
  completeImpl?: (req: CompletionRequest) => Promise<CompletionResponse> | CompletionResponse
): FakeProvider {
  return {
    flavor: 'openai',
    complete: mock.fn<(req: CompletionRequest) => Promise<CompletionResponse>>(
      completeImpl
        ? async (req: CompletionRequest) => completeImpl(req)
        : async () => makeCompletionResponse()
    ),
    capabilities: mock.fn<() => Promise<ProviderCapabilities>>(async () => DEFAULT_CAPABILITIES)
  }
}
