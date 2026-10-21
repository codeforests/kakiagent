import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import {
  agreement,
  AgreementSample,
  checkSample,
  isDraft,
  judge,
  MIN_AGREEMENT,
  parseVerdict,
} from './judge.js';

const item = (id: string, label: 'pass' | 'fail') => ({
  id,
  criterion: 'language' as const,
  messages: [{ role: 'user' as const, content: '请问周末营业时间？' }],
  reply: '周六营业时间是上午9:00至下午5:00。',
  label,
});

function sample(n: number, labelledBy = 'Ken', version = '0.5.0'): AgreementSample {
  return AgreementSample.parse({
    evalSetVersion: version,
    labelledBy,
    items: Array.from({ length: n }, (_, i) => item(`i${i}`, i % 2 ? 'fail' : 'pass')),
  });
}

describe('parseVerdict (AC-11)', () => {
  it('reads a pass and a fail from structured output', () => {
    expect(parseVerdict('{"verdict":"pass","reason":"Chinese"}')).toEqual({
      pass: true,
      reason: 'Chinese',
    });
    expect(parseVerdict('{"verdict":"fail","reason":"English"}').pass).toBe(false);
  });

  it('fails closed on anything else', () => {
    for (const text of ['', 'pass', '{"verdict":"PASS","reason":"x"}', '{"verdict":"pass"}', '[]'])
      expect(parseVerdict(text)).toEqual({ pass: false, reason: 'unparseable verdict' });
  });
});

describe('judge', () => {
  function gateway(script: (req: GenerateRequest) => string) {
    const calls: GenerateRequest[] = [];
    const llm = createGateway(defaultRegistry('fake'), [
      createFakeProvider((req) => {
        calls.push(req);
        return script(req);
      }),
    ]);
    return { llm, calls };
  }

  it('asks the judge model once with the rubric, the data and a schema', async () => {
    const { llm, calls } = gateway(() => '{"verdict":"pass","reason":"ok"}');
    const v = await judge(llm, {
      criterion: 'grounded',
      messages: [{ role: 'user', content: 'how much is the fudge cake?' }],
      reply: 'The Chocolate fudge cake is S$55.00.',
      facts: ['product: {"name":"Chocolate fudge cake","priceCents":5500}'],
    });
    expect(v.pass).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('judge');
    expect(calls[0]!.outputSchema).toBeDefined();
    const content = calls[0]!.messages[0]!.content;
    expect(content).toContain('Criterion: grounded');
    expect(content).toContain('<facts>\nproduct:');
    expect(content).toContain('<reply>\nThe Chocolate fudge cake is S$55.00.\n</reply>');
  });

  it("gives the tone criterion the tenant's tone, and other criteria none (FEAT-024)", async () => {
    const { llm, calls } = gateway(() => '{"verdict":"fail","reason":"particle"}');
    const input = {
      messages: [{ role: 'user' as const, content: 'fudge cake how much ah' }],
      reply: 'Fudge cake is S$55.00 lah.',
    };
    expect((await judge(llm, { ...input, criterion: 'tone', tone: 'professional' })).pass).toBe(
      false,
    );
    await judge(llm, { ...input, criterion: 'register' });
    expect(calls[0]!.messages[0]!.content).toContain('Criterion: tone');
    expect(calls[0]!.messages[0]!.content).toContain('\nTone: professional\n');
    expect(calls[0]!.messages[0]!.content).toContain('no Singlish particles');
    expect(calls[1]!.messages[0]!.content).not.toContain('Tone:');
  });

  it('counts a broken verdict or a failing provider as a fail', async () => {
    const broken = gateway(() => 'I think it passes');
    expect((await judge(broken.llm, { ...item('x', 'pass'), criterion: 'language' })).pass).toBe(
      false,
    );
    const down = gateway(() => {
      throw new Error('down');
    });
    expect(await judge(down.llm, { ...item('x', 'pass'), criterion: 'language' })).toMatchObject({
      pass: false,
    });
  });
});

describe('the agreement sample (ADR-022; AC-11)', () => {
  it('measures the share of verdicts equal to the labels', () => {
    const s = sample(10);
    const right = s.items.map((i) => ({ pass: i.label === 'pass', reason: '' }));
    expect(agreement(s, right)).toBe(1);
    const oneWrong = right.map((v, i) => (i === 0 ? { ...v, pass: !v.pass } : v));
    expect(agreement(s, oneWrong)).toBe(0.9);
    expect(agreement(s, oneWrong) >= MIN_AGREEMENT).toBe(true);
    const twoWrong = oneWrong.map((v, i) => (i === 1 ? { ...v, pass: !v.pass } : v));
    expect(agreement(s, twoWrong) >= MIN_AGREEMENT).toBe(false);
    // A missing verdict disagrees, whatever the label.
    expect(agreement(s, right.slice(0, 8))).toBe(0.8);
  });

  it('refuses draft labels until a person has reviewed them', () => {
    expect(isDraft(sample(1, 'draft (proposed by the implementer)'))).toBe(true);
    expect(isDraft(sample(1, ' Draft'))).toBe(true);
    expect(isDraft(sample(1, 'Ken, 2026-11-02'))).toBe(false);
  });

  it('checks the version and a size of at least 10% of the judge expectations', () => {
    expect(checkSample(sample(2), '0.5.0', 11)).toBeNull();
    expect(checkSample(sample(1), '0.5.0', 11)).toMatch(/1 item\(s\); 2 needed/);
    expect(checkSample(sample(3), '0.5.0', 30)).toBeNull();
    expect(checkSample(sample(3, 'Ken', '0.4.0'), '0.5.0', 11)).toMatch(
      /for eval set 0.4.0, not 0.5.0/,
    );
  });
});
