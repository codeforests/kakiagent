import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  createFakeProvider,
  createGateway,
  defaultRegistry,
  EMBEDDING_DIMENSIONS,
  gatewayFromConfig,
  scriptedOutputs,
  type GenerateRequest,
  type StreamChunk,
} from './index.js';

const req: GenerateRequest = {
  model: 'reply.simple',
  system: 'sys',
  messages: [{ role: 'user', content: 'how much is the cake?' }],
  maxTokens: 100,
  meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
};

async function collect(it: AsyncIterable<StreamChunk>) {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('llm-gateway stream', () => {
  it('streams the fake output in small chunks, then done with the whole result', async () => {
    const gw = createGateway(defaultRegistry('fake'), [
      createFakeProvider(() => 'The cake is [[f:abcd1234.price]].', { chunkSize: 5 }),
    ]);
    const chunks = await collect(gw.stream(req));
    const texts = chunks.flatMap((c) => (c.type === 'text' ? [c.text] : []));
    expect(texts.length).toBeGreaterThan(3);
    expect(texts.every((t) => t.length <= 5)).toBe(true);
    expect(texts.join('')).toBe('The cake is [[f:abcd1234.price]].');
    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.result.text).toBe(texts.join(''));
  });

  it('scripted outputs give one output per attempt and repeat the last', async () => {
    const gw = createGateway(defaultRegistry('fake'), [
      createFakeProvider(scriptedOutputs(['first', 'second'])),
    ]);
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await gw.generate(req)).text);
    expect(texts).toEqual(['first', 'second', 'second']);
  });

  it('falls back to one chunk when a provider cannot stream', async () => {
    const base = createFakeProvider(() => 'whole');
    const { stream: _s, ...noStream } = base;
    const gw = createGateway(defaultRegistry('fake'), [noStream]);
    const chunks = await collect(gw.stream(req));
    expect(chunks.map((c) => c.type)).toEqual(['text', 'done']);
  });

  it('propagates provider errors from the stream', async () => {
    const gw = createGateway(defaultRegistry('fake'), [
      createFakeProvider(() => {
        throw new Error('model unavailable');
      }),
    ]);
    await expect(collect(gw.stream(req))).rejects.toThrow('model unavailable');
  });
});

describe('llm-gateway embed', () => {
  const gw = gatewayFromConfig({ provider: 'fake' });
  const embed = async (texts: string[]) =>
    (await gw.embed({ texts, purpose: 'document', meta: { tenantId: req.meta.tenantId } })).vectors;

  it('returns one unit vector of 1024 dimensions per text, deterministically', async () => {
    const [a, b] = await embed(['Chocolate fudge cake', 'Chocolate fudge cake']);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(Math.abs(cosineSimilarity(a!, a!) - 1)).toBeLessThan(1e-9);
  });

  it('ranks texts that share words above unrelated ones', async () => {
    const [q, faq, product, other] = await embed([
      'got eggless cake or not? how much ah',
      'Do you have eggless cakes?\nYes, on request, 3 days ahead.',
      'Chocolate fudge cake, 1 kg. Price.',
      'Parking is available at the back of the shop.',
    ]);
    const s = (v: number[]) => cosineSimilarity(q!, v);
    expect(s(faq!)).toBeGreaterThan(s(other!));
    expect(s(product!)).toBeGreaterThan(s(other!));
  });

  it('embeds Chinese text by characters', async () => {
    const [q, hit, miss] = await embed([
      '有无蛋蛋糕吗',
      '无蛋蛋糕需要提前三天预订',
      '停车场在后面',
    ]);
    expect(cosineSimilarity(q!, hit!)).toBeGreaterThan(cosineSimilarity(q!, miss!));
  });

  it('keeps embeddings on the local embedder with the anthropic-dev provider (D5)', async () => {
    const dev = gatewayFromConfig({ provider: 'anthropic-dev', anthropicApiKey: 'test-key' });
    const res = await dev.embed({ texts: ['x'], purpose: 'query', meta: { tenantId: 't' } });
    expect(res.provider).toBe('fake');
  });
});
