import { describe, expect, it } from 'vitest';
import { formatSgd, renderSegment, withGst } from './render.js';
import { Segmenter } from './segment.js';
import { assignRefs, openSlotAt } from './slots.js';
import { EGGLESS, EXCLUSIVE, FUDGE } from './testing/facts.js';
import { verifySegment } from './verify.js';

const facts = assignRefs([FUDGE, EGGLESS, EXCLUSIVE]);
const ref = (id: string) => facts.refOf.get(id)!;

function renderAndVerify(raw: string, gstRegistered = true, visitor: string[] = []) {
  const r = renderSegment(raw, facts, gstRegistered);
  if (!r.ok) return { rendered: null, verify: { ok: false as const, violations: r.violations } };
  return { rendered: r, verify: verifySegment(r.text, r.spans, visitor) };
}

describe('slot refs', () => {
  it('uses 8 hex characters and lengthens them for facts sharing a prefix', () => {
    expect(ref(FUDGE.id)).toBe('9c1e4a2b');
    const twins = assignRefs([
      { ...FUDGE, id: 'aaaaaaaa-0000-4000-8000-000000000001' },
      { ...FUDGE, id: 'aaaaaaaa-0000-4000-8000-000000000002' },
    ]);
    const refs = [...twins.byRef.keys()];
    expect(new Set(refs).size).toBe(2);
    expect(refs.every((r) => r.length > 8)).toBe(true);
  });

  it('detects an open slot at the end of a buffer', () => {
    expect(openSlotAt('The cake is [[f:9c')).toBe(12);
    expect(openSlotAt('The cake is [')).toBe(12);
    expect(openSlotAt('The cake is [[f:9c1e4a2b.price]]')).toBe(-1);
  });
});

describe('renderer (AC-1, AC-10; KB-15, NFR-10)', () => {
  it('renders a price slot from the fact, with the facts used', () => {
    const r = renderSegment(
      `The ${'[[f:'}${ref(FUDGE.id)}.name]] is [[f:${ref(FUDGE.id)}.price]].`,
      facts,
      true,
    );
    expect(r).toMatchObject({
      ok: true,
      text: 'The Chocolate fudge cake is S$55.00.',
      factIds: [FUDGE.id],
    });
  });

  it('quotes an exclusive price GST-inclusive for a registered tenant', () => {
    const raw = `[[f:${ref(EXCLUSIVE.id)}.price]]`;
    expect(renderSegment(raw, facts, true)).toMatchObject({ text: 'S$59.95 incl. GST' });
    expect(renderSegment(raw, facts, false)).toMatchObject({ text: 'S$55.00' });
    expect(renderSegment(`[[f:${ref(FUDGE.id)}.price]]`, facts, false)).toMatchObject({
      text: 'S$55.00',
    });
  });

  it('formats SGD with thousands separators and rounds GST half up', () => {
    expect(formatSgd(123450)).toBe('S$1,234.50');
    expect(formatSgd(5)).toBe('S$0.05');
    expect(formatSgd(100000000)).toBe('S$1,000,000.00');
    expect(withGst(5500)).toBe(5995);
    expect(withGst(50)).toBe(55); // 54.5 → 55
  });

  it('drops a currency sign the model typed before a price slot', () => {
    expect(renderSegment(`Only S$[[f:${ref(FUDGE.id)}.price]]`, facts, true)).toMatchObject({
      text: 'Only S$55.00',
    });
  });

  it('fails a slot naming a fact outside the turn or an unknown field', () => {
    expect(renderSegment('[[f:deadbeef.price]]', facts, true)).toMatchObject({
      ok: false,
      violations: [{ kind: 'unknown_fact' }],
    });
    expect(renderSegment(`[[f:${ref(EGGLESS.id)}.price]]`, facts, true)).toMatchObject({
      ok: false,
      violations: [{ kind: 'unknown_field' }],
    });
    const noUnit = assignRefs([EXCLUSIVE]);
    expect(
      renderSegment(`[[f:${noUnit.refOf.get(EXCLUSIVE.id)}.unit]]`, noUnit, true),
    ).toMatchObject({ ok: false });
  });
});

describe('verifier (AC-3; AGT-02)', () => {
  it.each([
    ['The cake is S$50.', 'currency'],
    ['It costs $50 only.', 'currency'],
    ['That will be 50 dollars.', 'currency'],
    ['About fifty bucks lah.', 'currency'],
    ['SGD 50 for one.', 'currency'],
    ['价格是50元。', 'currency'],
    ['You get 10% off.', 'percentage'],
    ['Order 3 days ahead.', 'duration'],
    ['Order three days ahead.', 'duration'],
    ['需要提前三天。', 'duration'],
    ['Ready by 12 Oct.', 'date'],
    ['Ready on Oct 12.', 'date'],
    ['Collect on 12/10.', 'date'],
    ['We close at 3pm.', 'time'],
    ['Open until 21:00.', 'time'],
    ['Only 5 left!', 'stock'],
    ['It is in stock.', 'stock'],
    ['You get a full refund.', 'policy'],
    ['The price is 55.', 'price_number'],
    // Acceptance rework R1–R4 and the gaps it listed.
    ['The fudge cake goes for 50.', 'price_number'],
    ['Price: 50.', 'price_number'],
    ['Price - 55.', 'price_number'],
    ['It costs fifty-five.', 'price_number'],
    ['It is around 50 Singapore dollars.', 'currency'],
    ['It is S$  50.', 'currency'],
    ['That is USD 50.', 'currency'],
    ['That is €50.', 'currency'],
    ['That is RM50.', 'currency'],
    ['价格是５０元。', 'currency'],
    ['It is S＄50.', 'currency'],
    ['See [[f:9c1e4a2b.price', 'slot_syntax'],
  ])('blocks %j (%s)', (text, kind) => {
    const r = verifySegment(text, [], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.kind)).toContain(kind);
  });

  it('passes the same values when they come from slots', () => {
    const { verify, rendered } = renderAndVerify(
      `[[f:${ref(EGGLESS.id)}.answer]] The [[f:${ref(FUDGE.id)}.name]] is [[f:${ref(FUDGE.id)}.price]].`,
    );
    expect(rendered?.text).toBe(
      'Yes, on request, 3 days ahead. The Chocolate fudge cake is S$55.00.',
    );
    expect(verify).toEqual({ ok: true });
    expect(renderAndVerify(`[[f:${ref(EXCLUSIVE.id)}.price]]`).verify).toEqual({ ok: true });
  });

  // D13 replaced "harmless numbers pass": the model types no numbers at all, so a
  // count the model typed is blocked; counts the visitor typed and slot values pass.
  it('passes ordinary sentences without typed numbers', () => {
    for (const t of [
      'Hi! How can I help you today?',
      'We have three flavours to choose from.',
      'Let me check with the team and get back to you.',
    ])
      expect(verifySegment(t, [], []), t).toEqual({ ok: true });
  });

  it.each([
    'Prices start from 50.',
    'The price would be about 50.',
    'It costs approx. 50.',
    'It is 55 each.',
    'It is 55.00.',
    'Members pay 50.',
    'Between 50 and 60.',
    'It is 55 per kg.',
    'Pricing: 50',
    '50.',
    '50$',
    'It is 50 S$.',
    'Members pay fifty.',
    'It is sixty-five.',
    'We have 3 flavours.',
  ])('blocks a number the model typed (D13): %j', (text) => {
    expect(verifySegment(text, [], []).ok).toBe(false);
  });

  it('blocks a digit typed straight after a rendered price (R5)', () => {
    const { verify } = renderAndVerify(`It is [[f:${ref(FUDGE.id)}.price]]0.`);
    expect(verify.ok).toBe(false);
  });

  it('passes a count the visitor typed, before a quantity noun', () => {
    expect(
      verifySegment('Yes, it is enough for 8 people.', [], ['is it enough for 8 people?']),
    ).toEqual({ ok: true });
    expect(verifySegment('Yes, 8 is fine.', [], ['is 8 ok?']).ok).toBe(false);
  });

  it('allows a plain quantity the visitor typed, never a currency amount (D3)', () => {
    expect(verifySegment('Sure, we can do 200 pieces.', [], ['Can I order 200 pieces?'])).toEqual({
      ok: true,
    });
    expect(verifySegment('Sure, we can do 200 pieces.', [], ['Can I order cupcakes?']).ok).toBe(
      false,
    );
    expect(verifySegment('Yes, it is $20.', [], ['is it $20?']).ok).toBe(false);
    expect(verifySegment('Yes, the price is 20.', [], ['is the price 20?']).ok).toBe(false);
  });

  it('blocks a literal price typed next to a correct slot', () => {
    const { verify } = renderAndVerify(`It is [[f:${ref(FUDGE.id)}.price]], or S$50 for members.`);
    expect(verify.ok).toBe(false);
  });
});

describe('segmenter (ADR-008 decision 4)', () => {
  function feed(text: string, size = 3) {
    const s = new Segmenter();
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
    const rest = s.flush();
    if (rest) out.push(rest);
    return out;
  }

  it('releases whole sentences, however the stream is chunked', () => {
    const text = 'Yes we do! The cake is [[f:9c1e4a2b.price]]. Order early? Thanks.';
    for (const size of [1, 2, 5, 13, 100])
      expect(feed(text, size)).toEqual([
        'Yes we do!',
        'The cake is [[f:9c1e4a2b.price]].',
        'Order early?',
        'Thanks.',
      ]);
  });

  it('never cuts inside a slot or between the digits of a decimal', () => {
    expect(feed('It weighs 1.5 kg. Next.')).toEqual(['It weighs 1.5 kg.', 'Next.']);
    const s = new Segmenter();
    expect(s.push('Price: [[f:9c1e4a2b')).toEqual([]);
    expect(s.push('.price]] each. ')).toEqual(['Price: [[f:9c1e4a2b.price]] each.']);
  });

  it('keeps a line ending in a currency sign or colon with the next line (DD2)', () => {
    const seg = new Segmenter();
    expect(seg.push('S$\n50 ')).toEqual([]);
    expect(seg.push('more.\n')).toEqual(['S$\n50 more.']);
  });

  it('splits at line breaks and CJK full stops', () => {
    expect(feed('Line one\nLine two')).toEqual(['Line one', 'Line two']);
    expect(feed('有的。需要提前预订。')).toEqual(['有的。', '需要提前预订。']);
  });

  it('cuts a long run-on at the last word boundary before 160 characters', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const segs = feed(long, 10);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.every((s) => s.length <= 160)).toBe(true);
    expect(segs.join(' ')).toBe(long);
  });
});
