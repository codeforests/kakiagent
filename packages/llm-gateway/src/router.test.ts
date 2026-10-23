import { describe, expect, it } from 'vitest';
import { createFakeProvider, createGateway, defaultRegistry, gatewayFromConfig } from './index.js';
import { purposeOf } from './router.js';

describe('llm-gateway', () => {
  it('echoes deterministically through the fake provider', async () => {
    const gw = gatewayFromConfig({ provider: 'fake' });
    const res = await gw.generate({
      model: 'reply.simple',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.text).toBe('Echo: hello');
    expect(res.provider).toBe('fake');
    expect(res.providerModelId).toBe('fake-haiku');
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  it('fails clearly when a registry entry has no configured provider', async () => {
    const gw = createGateway(defaultRegistry('anthropic-dev'), [createFakeProvider()]);
    await expect(
      gw.generate({
        model: 'triage',
        system: '',
        messages: [],
        maxTokens: 1,
        meta: { tenantId: 'x' },
      }),
    ).rejects.toThrow(/anthropic-dev is not configured/);
  });

  it('refuses the dev provider without an API key', () => {
    expect(() => gatewayFromConfig({ provider: 'anthropic-dev' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('mine (FEAT-017 §5.4)', () => {
  it('routes chat-export mining to Haiku 5.5 and records it as extraction', async () => {
    expect(defaultRegistry('anthropic-dev').mine.modelId).toBe('claude-haiku-5-5');
    expect(defaultRegistry('fake').mine.modelId).toBe('fake-haiku');
    expect(purposeOf('mine')).toBe('extract');
    const gw = createGateway(defaultRegistry('fake'), [createFakeProvider(() => '{"pairs":[]}')]);
    const res = await gw.generate({
      model: 'mine',
      system: 'sys',
      messages: [{ role: 'user', content: 'Customer: hi?' }],
      maxTokens: 100,
      meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.providerModelId).toBe('fake-haiku');
  });
});
