import type { ModelRegistry, ProviderId } from './types.js';

/**
 * Logical model → provider model (ADR-007 decision 5). Configuration, not code: the
 * Bedrock `au.` entries and the price table are added with the Bedrock provider (MD).
 */
export function defaultRegistry(provider: Exclude<ProviderId, 'bedrock'>): ModelRegistry {
  if (provider === 'fake') {
    const fake = (modelId: string) => ({ provider: 'fake' as const, modelId });
    return {
      triage: fake('fake-haiku'),
      'reply.simple': fake('fake-haiku'),
      'reply.complex': fake('fake-sonnet'),
      extract: fake('fake-sonnet'),
      summarise: fake('fake-haiku'),
      judge: fake('fake-opus'),
    };
  }
  const dev = (modelId: string) => ({ provider: 'anthropic-dev' as const, modelId });
  return {
    triage: dev('claude-haiku-5-5'),
    'reply.simple': dev('claude-haiku-5-5'),
    'reply.complex': dev('claude-sonnet-5-5'),
    extract: dev('claude-sonnet-5-5'),
    summarise: dev('claude-haiku-5-5'),
    judge: dev('claude-opus-5-5'),
  };
}
