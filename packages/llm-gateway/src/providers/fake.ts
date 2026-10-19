import type { GenerateRequest, GenerateResult, ModelProvider } from '../types.js';

/**
 * Deterministic scripted provider for local development and tests (plan §2, P10).
 * The skeleton's agent echoes through it. FEAT-022 adds recorded fixtures and
 * adversarial outputs (literal prices, wrong slots, echoed injections).
 */
export function createFakeProvider(script?: (req: GenerateRequest) => string): ModelProvider {
  return {
    id: 'fake',
    capabilities: {
      promptCaching: false,
      structuredOutputs: false,
      toolUse: false,
      streaming: false,
      maxContextTokens: 1_000_000,
    },
    async generate(req, providerModelId): Promise<GenerateResult> {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = script ? script(req) : `Echo: ${last?.content ?? ''}`;
      return {
        text,
        stopReason: 'end',
        provider: 'fake',
        providerModelId,
        usage: {
          inputTokens: req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0),
          outputTokens: Math.ceil(text.length / 4),
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      };
    },
  };
}
