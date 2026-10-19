import Anthropic from '@anthropic-ai/sdk';
import type { GenerateResult, ModelProvider } from '../types.js';

/**
 * Anthropic API provider for development with TEST DATA ONLY (architecture Q1,
 * ADR-007 decision 5). Production inference goes through Bedrock's `au.` profile
 * (ADR-006), which FEAT-022/MD add as the `bedrock` provider. Enabled only when
 * LLM_PROVIDER=anthropic-dev and ANTHROPIC_API_KEY is set.
 */
export function createAnthropicDevProvider(apiKey: string): ModelProvider {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 });
  return {
    id: 'anthropic-dev',
    capabilities: {
      promptCaching: true,
      structuredOutputs: true,
      toolUse: true,
      streaming: true,
      maxContextTokens: 1_000_000,
    },
    async generate(req, providerModelId): Promise<GenerateResult> {
      const response = await client.messages.create({
        model: providerModelId,
        max_tokens: req.maxTokens,
        system: req.system,
        output_config: { effort: 'low' },
        messages: req.messages,
      });
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return {
        text,
        stopReason:
          response.stop_reason === 'end_turn'
            ? 'end'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : response.stop_reason === 'refusal'
                ? 'refusal'
                : 'other',
        provider: 'anthropic-dev',
        providerModelId,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
