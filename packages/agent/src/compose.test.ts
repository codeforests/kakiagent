import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  scriptedOutputs,
  type FakeScript,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import { composeReply, type ComposeInput } from './compose.js';
import { fakeVisitorResponder } from './fake-responder.js';
import { assignRefs } from './slots.js';
import { EGGLESS, FUDGE } from './testing/facts.js';
import { texts } from './texts.js';

const P = assignRefs([FUDGE, EGGLESS]).refOf.get(FUDGE.id)!;
const Q = assignRefs([FUDGE, EGGLESS]).refOf.get(EGGLESS.id)!;

const input: ComposeInput = {
  facts: [FUDGE, EGGLESS],
  history: [{ role: 'user', content: 'got eggless cake or not? how much ah' }],
  businessName: 'Kaki Bakery',
  gstRegistered: true,
  meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
};

function run(script: FakeScript, opts: { gate?: () => Promise<boolean>; chunkSize?: number } = {}) {
  const prompts: GenerateRequest[] = [];
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider(
      (req) => {
        prompts.push(req);
        return script(req);
      },
      { chunkSize: opts.chunkSize ?? 4 },
    ),
  ]);
  const published: { seq: number; text: string }[] = [];
  return composeReply(input, {
    llm,
    gateOpen: opts.gate ?? (async () => true),
    publish: async (s) => {
      published.push(s);
    },
  }).then((result) => ({ result, published, prompts }));
}

describe('composeReply (ADR-008)', () => {
  it('releases verified sentences one at a time with the facts used (AC-1, AC-4)', async () => {
    const { result, published } = await run(
      () => `Yes we have! [[f:${Q}.answer]] The [[f:${P}.name]] is [[f:${P}.price]].`,
    );
    expect(result.outcome).toBe('answered');
    // Segments are cut on the raw text, so a slot's own full stops don't split it.
    expect(published).toEqual([
      { seq: 0, text: 'Yes we have!' },
      { seq: 1, text: 'Yes, on request, 3 days ahead. The Chocolate fudge cake is S$55.00.' },
    ]);
    expect(result.text).toBe(
      'Yes we have! Yes, on request, 3 days ahead. The Chocolate fudge cake is S$55.00.',
    );
    expect(result.factIds.sort()).toEqual([FUDGE.id, EGGLESS.id].sort());
    expect(result.timings.firstSegmentMs).not.toBeNull();
  });

  it('blocks a literal price, regenerates from the released prefix and never publishes it (AC-2)', async () => {
    const { result, published, prompts } = await run(
      scriptedOutputs([
        `Yes we have eggless cakes. The fudge cake is S$50 only.`,
        `The [[f:${P}.name]] is [[f:${P}.price]].`,
      ]),
    );
    expect(result.outcome).toBe('answered');
    expect(published.map((p) => p.text)).toEqual([
      'Yes we have eggless cakes.',
      'The Chocolate fudge cake is S$55.00.',
    ]);
    expect(published.some((p) => p.text.includes('S$50'))).toBe(false);
    expect(result.violations).toEqual([{ kind: 'currency', text: 'S$50' }]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.tail).toContain('blocked by the fact checker');
    expect(prompts[1]!.tail).toContain('"Yes we have eggless cakes."');
  });

  it('escalates after two failed attempts and publishes only verified text (AC-2)', async () => {
    const { result, published } = await run(
      scriptedOutputs(['It costs fifty bucks.', 'Hmm, around $48 lah.']),
    );
    expect(result.outcome).toBe('escalated');
    expect(published).toEqual([{ seq: 0, text: texts.escalation }]);
    expect(result.violations.map((v) => v.kind)).toEqual(['currency', 'currency']);
    expect(result.attempts).toBe(2);
  });

  it('fails a slot that names a fact outside the turn (another tenant, a stale ref)', async () => {
    const { result, published } = await run(
      scriptedOutputs(['It is [[f:deadbeef.price]].', 'It is [[f:deadbeef.price]].']),
    );
    expect(result.outcome).toBe('escalated');
    expect(published.map((p) => p.text)).toEqual([texts.escalation]);
    expect(result.violations[0]).toMatchObject({ kind: 'unknown_fact' });
  });

  it('holds a slot cut across stream chunks until it is complete', async () => {
    const { published } = await run(() => `It is [[f:${P}.price]].`, { chunkSize: 1 });
    expect(published).toEqual([{ seq: 0, text: 'It is S$55.00.' }]);
  });

  it('stops releasing when the gate closes between segments (AC-14)', async () => {
    let checks = 0;
    const { result, published } = await run(() => `First sentence. Second sentence.`, {
      gate: async () => ++checks === 1,
    });
    expect(result.outcome).toBe('gate_closed');
    expect(published).toEqual([{ seq: 0, text: 'First sentence.' }]);
    expect(result.text).toBe('First sentence.');
  });

  it('reports the provider as unavailable when the model call fails (AC-13)', async () => {
    const { result, published } = await run(() => {
      throw new Error('model unavailable');
    });
    expect(result.outcome).toBe('unavailable');
    expect(published).toEqual([]);
  });

  it('treats an empty reply as a failure', async () => {
    const { result } = await run(scriptedOutputs(['', '']));
    expect(result.outcome).toBe('escalated');
  });

  it('builds a slot-correct answer with the fake responder (local dev and E2E)', async () => {
    const { result } = await run(fakeVisitorResponder);
    expect(result.outcome).toBe('answered');
    expect(result.text).toBe(
      'The Chocolate fudge cake (1 kg) is S$55.00. Yes, on request, 3 days ahead.',
    );
  });

  it('says it will check when no facts were retrieved (AC-5)', async () => {
    const llm = createGateway(defaultRegistry('fake'), [createFakeProvider(fakeVisitorResponder)]);
    const published: string[] = [];
    const result = await composeReply(
      { ...input, facts: [] },
      { llm, gateOpen: async () => true, publish: async (s) => void published.push(s.text) },
    );
    expect(result.outcome).toBe('answered');
    expect(result.factIds).toEqual([]);
    expect(result.text).toContain('check with the team');
  });

  it('puts the facts and the slot rule in the prompt and keeps only the last 10 messages', async () => {
    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const prompts: GenerateRequest[] = [];
    const llm = createGateway(defaultRegistry('fake'), [
      createFakeProvider((r) => {
        prompts.push(r);
        return 'Hello there.';
      }),
    ]);
    await composeReply(
      { ...input, history },
      { llm, gateOpen: async () => true, publish: async () => {} },
    );
    expect(prompts[0]!.tail).toContain(`[[f:${P}.price]]`);
    expect(prompts[0]!.system).toContain('SLOT RULE');
    expect(prompts[0]!.messages).toHaveLength(10);
    expect(prompts[0]!.messages.at(-1)?.content).toBe('m13');
  });
});

describe('the fake responder in Chinese and for hours (FEAT-023 T4)', () => {
  const HOURS = new Map([
    ['hours.sat', '上午9:00至下午5:00'],
    ['hours.sun', '上午9:00至中午1:00'],
    ['hours.today', '上午8:00至晚上7:00'],
  ]);
  const compose = (question: string, extra: Partial<ComposeInput>) => {
    const llm = createGateway(defaultRegistry('fake'), [
      createFakeProvider(fakeVisitorResponder, { chunkSize: 3 }),
    ]);
    return composeReply(
      { ...input, history: [{ role: 'user', content: question }], ...extra },
      { llm, gateOpen: async () => true, publish: async () => {} },
    );
  };

  it('answers a price in Chinese with slots that pass the verifier', async () => {
    const r = await compose('chocolate fudge cake 多少钱？', { language: 'zh', facts: [FUDGE] });
    expect(r).toMatchObject({ outcome: 'answered', attempts: 1 });
    expect(r.text).toBe('Chocolate fudge cake（1 kg）的价格是S$55.00。');
  });

  it('answers J7 from the hours slots', async () => {
    const hours = {
      hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      openOnPublicHolidays: false,
      status: {
        open: true,
        since: null,
        nextOpen: null,
        today: [],
        closedForHoliday: false,
        closedReason: null,
      },
      now: new Date(),
    };
    const r = await compose('请问周末营业时间？', {
      language: 'zh',
      facts: [],
      hours,
      systemSlots: HOURS,
    });
    expect(r).toMatchObject({ outcome: 'answered', slots: ['hours.sat', 'hours.sun'] });
    expect(r.text).toBe('周六营业时间是上午9:00至下午5:00，周日是上午9:00至中午1:00。');
  });

  it('says it will check, in Chinese, when nothing matches', async () => {
    const r = await compose('你们有榴莲蛋糕吗？', { language: 'zh', facts: [] });
    expect(r.text).toBe('这个我不太确定，我先跟团队确认一下再回复您。');
  });

  it('escalates in the reply language', async () => {
    const llm = createGateway(defaultRegistry('fake'), [
      createFakeProvider(scriptedOutputs(['S$1', 'S$2'])),
    ]);
    const r = await composeReply(
      { ...input, language: 'zh' },
      { llm, gateOpen: async () => true, publish: async () => {} },
    );
    expect(r).toMatchObject({ outcome: 'escalated', text: '我先跟团队确认一下，稍后回复您。' });
  });
});
