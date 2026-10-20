import { describe, expect, it } from 'vitest';
import {
  costOf,
  createFakeProvider,
  createGateway,
  defaultRegistry,
  PRICES,
  type GenerateRequest,
  type ModelProvider,
  type UsageEvent,
} from './index.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const meta = { tenantId, conversationId: 'c-1', turnId: 'm-1' };

describe('costOf (FEAT-004 AC-5)', () => {
  it('prices input, cache writes, cache reads and output per million tokens', () => {
    const usage = {
      inputTokens: 1_000,
      cacheWriteInputTokens: 2_000,
      cacheReadInputTokens: 3_000,
      outputTokens: 400,
    };
    // Sonnet: 1000×2 + 2000×2.5 + 3000×0.2 + 400×10 = 11,600 per million.
    expect(costOf(usage, PRICES.sonnet)).toBeCloseTo(0.0116, 10);
    // Haiku: 1000×0.1 + 2000×0.125 + 3000×0.01 + 400×0.5 = 580 per million.
    expect(costOf(usage, PRICES.haiku)).toBeCloseTo(0.00058, 10);
    expect(costOf(usage, { ...PRICES.haiku, multiplier: 1.1 })).toBeCloseTo(0.000638, 10);
    expect(
      costOf(
        { inputTokens: 0, cacheWriteInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        PRICES.opus,
      ),
    ).toBe(0);
  });

  // Acceptance correction (AC-5: "for each price table"): Opus was only checked at zero
  // usage and the embed price only against costOf itself.
  it('matches a hand calculation for the Opus and embed price tables', () => {
    const usage = {
      inputTokens: 1_000,
      cacheWriteInputTokens: 2_000,
      cacheReadInputTokens: 3_000,
      outputTokens: 400,
    };
    // Opus: 1000×4 + 2000×5 + 3000×0.2 + 400×20 = 22,600 per million.
    expect(costOf(usage, PRICES.opus)).toBeCloseTo(0.0226, 10);
    // Embed: input only, 1000×0.1 = 100 per million; other counts are free.
    expect(costOf(usage, PRICES.embed)).toBeCloseTo(0.0001, 10);
    // Sonnet through the Bedrock route premium: 11,600 × 1.1 = 12,760 per million.
    expect(costOf(usage, { ...PRICES.sonnet, multiplier: 1.1 })).toBeCloseTo(0.01276, 10);
  });
});

describe('usage events (ADR-021, FEAT-004 AC-4)', () => {
  function gateway(provider: ModelProvider = createFakeProvider(() => 'hello there')) {
    const events: UsageEvent[] = [];
    const gw = createGateway(defaultRegistry('fake'), [provider], {
      onUsage: async (e) => {
        events.push(e);
      },
    });
    return { gw, events };
  }
  const req = (model: GenerateRequest['model']): GenerateRequest => ({
    model,
    system: 'rules',
    messages: [{ role: 'user', content: 'hi' }],
    tail: 'facts',
    maxTokens: 10,
    meta,
  });

  it('emits one priced event per generate, with the purpose from the logical model', async () => {
    const { gw, events } = gateway();
    const result = await gw.generate(req('triage'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      conversationId: 'c-1',
      turnId: 'm-1',
      purpose: 'triage',
      model: 'triage',
      provider: 'fake',
      providerModelId: 'fake-haiku',
    });
    expect(result.costUsd).toBe(costOf(result.usage, PRICES.haiku));
    expect(events[0]!.costUsd).toBe(result.costUsd);
    expect(events[0]!.inputTokens).toBe(result.usage.inputTokens);
  });

  it('emits one event when a stream finishes, priced for the routed model', async () => {
    const { gw, events } = gateway();
    let done = 0;
    for await (const c of gw.stream(req('reply.complex'))) {
      if (c.type === 'done') {
        done++;
        expect(c.result.costUsd).toBe(costOf(c.result.usage, PRICES.sonnet));
      }
    }
    expect(done).toBe(1);
    expect(events.map((e) => [e.purpose, e.model, e.providerModelId])).toEqual([
      ['reply', 'reply.complex', 'fake-sonnet'],
    ]);
  });

  it('records a generate-only provider used for streaming', async () => {
    const fake = createFakeProvider(() => 'x');
    const { gw, events } = gateway({ ...fake, stream: undefined });
    for await (const _ of gw.stream(req('reply.simple'))) void _;
    expect(events).toHaveLength(1);
  });

  it('emits nothing when a stream fails before done', async () => {
    const fake = createFakeProvider();
    const { gw, events } = gateway({
      ...fake,
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('provider down');
      },
    });
    await expect(async () => {
      for await (const _ of gw.stream(req('reply.simple'))) void _;
    }).rejects.toThrow('provider down');
    expect(events).toHaveLength(0);
  });

  it('records embeddings with input tokens at the embed price', async () => {
    const { gw, events } = gateway();
    const out = await gw.embed({ texts: ['eggless cake'], purpose: 'query', meta });
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    expect(events).toEqual([
      expect.objectContaining({
        purpose: 'embed',
        model: 'embed',
        outputTokens: 0,
        inputTokens: out.usage.inputTokens,
        costUsd: costOf(
          {
            inputTokens: out.usage.inputTokens,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
          PRICES.embed,
        ),
      }),
    ]);
  });

  it('counts the tail and tools as input on the fake provider', async () => {
    const { gw } = gateway();
    const base = await gw.generate({ ...req('triage'), tail: undefined });
    const withTail = await gw.generate({
      ...req('triage'),
      tail: 'x'.repeat(400),
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    });
    expect(withTail.usage.inputTokens).toBeGreaterThan(base.usage.inputTokens + 99);
  });
});
