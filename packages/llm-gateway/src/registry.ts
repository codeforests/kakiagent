import type { ModelRegistry, PriceTable, ProviderId } from './types.js';

/**
 * List prices, USD per million tokens (input / 5-minute cache write / cache read /
 * output), from the Anthropic price list on 2026-10-20 (ADR-007; FEAT-004 D5: Sonnet
 * 5.5 cache reads are 0.20, not ADR-007's 0.10). The Bedrock `au.` entries add
 * `multiplier: 1.1` with the Bedrock provider at MD.
 */
export const PRICES = {
  haiku: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  sonnet: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  opus: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  /** Cohere Embed Multilingual v3 (ADR-019): input only. */
  embed: { input: 0.1, cacheWrite: 0, cacheRead: 0, output: 0 },
} as const satisfies Record<string, PriceTable>;

/**
 * Logical model → provider model and price (ADR-007 decision 5). Configuration, not
 * code. The fake models are priced as their Claude counterparts, so local and eval
 * runs report a realistic cost per conversation.
 */
export function defaultRegistry(provider: Exclude<ProviderId, 'bedrock'>): ModelRegistry {
  if (provider === 'fake') {
    const fake = (modelId: string, price: PriceTable) => ({
      provider: 'fake' as const,
      modelId,
      price,
    });
    return {
      triage: fake('fake-haiku', PRICES.haiku),
      'reply.simple': fake('fake-haiku', PRICES.haiku),
      'reply.complex': fake('fake-sonnet', PRICES.sonnet),
      extract: fake('fake-sonnet', PRICES.sonnet),
      mine: fake('fake-haiku', PRICES.haiku),
      summarise: fake('fake-haiku', PRICES.haiku),
      judge: fake('fake-opus', PRICES.opus),
      embed: fake('fake-embed', PRICES.embed),
    };
  }
  const dev = (modelId: string, price: PriceTable) => ({
    provider: 'anthropic-dev' as const,
    modelId,
    price,
  });
  return {
    triage: dev('claude-haiku-5-5', PRICES.haiku),
    'reply.simple': dev('claude-haiku-5-5', PRICES.haiku),
    'reply.complex': dev('claude-sonnet-5-5', PRICES.sonnet),
    extract: dev('claude-sonnet-5-5', PRICES.sonnet),
    mine: dev('claude-haiku-5-5', PRICES.haiku),
    summarise: dev('claude-haiku-5-5', PRICES.haiku),
    judge: dev('claude-opus-5-5', PRICES.opus),
    // Anthropic has no embedding API: the local embedder stands in (FEAT-022 D5).
    embed: { provider: 'fake', modelId: 'fake-embed', price: PRICES.embed },
  };
}
