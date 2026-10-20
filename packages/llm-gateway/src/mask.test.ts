import { describe, expect, it } from 'vitest';
import { createFakeProvider, createGateway, defaultRegistry } from './index.js';
import type { EmbedRequest, GenerateRequest, ModelProvider } from './types.js';

/** A fake provider that records every request it receives (FEAT-003 AC-6). */
function recording() {
  const seen: { generate: GenerateRequest[]; embed: EmbedRequest[] } = { generate: [], embed: [] };
  const fake = createFakeProvider(() => 'ok');
  const provider: ModelProvider = {
    ...fake,
    async generate(req, id) {
      seen.generate.push(req);
      return fake.generate(req, id);
    },
    async *stream(req, id) {
      seen.generate.push(req);
      yield* fake.stream!(req, id);
    },
    async embed(req, id) {
      seen.embed.push(req);
      return fake.embed!(req, id);
    },
  };
  return { gw: createGateway(defaultRegistry('fake'), [provider]), seen };
}

const meta = { tenantId: '11111111-1111-4111-8111-111111111111' };
const request = (): GenerateRequest => ({
  model: 'reply.simple',
  system: 'Pay by PayNow to DBS acct 123-456789-0',
  messages: [
    { role: 'user', content: 'my IC S1234567D' },
    { role: 'assistant', content: 'Our DBS account is 123-456789-0' },
    { role: 'user', content: 'card 4242 4242 4242 4242' },
  ],
  maxTokens: 100,
  meta,
});

describe('gateway PII backstop (GOV-04, FEAT-003 D3)', () => {
  it('masks user content in generate and stream, and leaves system and assistant text', async () => {
    const { gw, seen } = recording();
    await gw.generate(request());
    for await (const _ of gw.stream(request()));
    expect(seen.generate).toHaveLength(2);
    for (const req of seen.generate) {
      expect(req.messages.map((m) => m.content)).toEqual([
        'my IC [NRIC ••••567D]',
        'Our DBS account is 123-456789-0',
        'card [CARD ••••4242]',
      ]);
      expect(req.system).toBe('Pay by PayNow to DBS acct 123-456789-0');
    }
  });

  it('does not change the caller’s request object', async () => {
    const { gw } = recording();
    const req = request();
    await gw.generate(req);
    expect(req.messages[0]!.content).toBe('my IC S1234567D');
  });

  it('masks query embeddings and leaves document embeddings', async () => {
    const { gw, seen } = recording();
    await gw.embed({ texts: ['ic S1234567D'], purpose: 'query', meta });
    await gw.embed({ texts: ['DBS acct 123-456789-0'], purpose: 'document', meta });
    expect(seen.embed.map((r) => r.texts)).toEqual([
      ['ic [NRIC ••••567D]'],
      ['DBS acct 123-456789-0'],
    ]);
  });
});
