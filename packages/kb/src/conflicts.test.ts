import { describe, expect, it } from 'vitest';
import { conflictId, entityKey, planPromotion, sameValue, type ExistingFact } from './conflicts.js';
import type { FactInput, GstTreatment } from './types.js';

const product = (
  priceCents: number,
  gst: GstTreatment = 'inclusive',
  name = 'Pandan chiffon cake',
  unit = '20 cm',
): FactInput => ({
  type: 'product',
  value: { name, priceCents, currency: 'SGD', unit },
  gstTreatment: gst,
});
const day = (d: string) => new Date(`${d}T00:00:00+08:00`);
const promotion = (details: string, until = '2026-12-26', priceCents?: number): FactInput => ({
  type: 'promotion',
  value: {
    title: 'Christmas log cake',
    details,
    ...(priceCents ? { priceCents, currency: 'SGD' } : {}),
  },
  gstTreatment: priceCents ? 'unknown' : null,
  validity: { validFrom: null, validUntil: day(until) },
});
const policy = (details: string, kind: 'refund' | 'delivery' = 'refund'): FactInput => ({
  type: 'policy',
  value: { kind, title: 'Refund policy', details },
  gstTreatment: null,
});
const faq = (answer: string): FactInput => ({
  type: 'faq',
  value: { question: 'Can I collect on Sundays?', answer },
  gstTreatment: null,
});

describe('entityKey and conflictId (FEAT-014 §5.1)', () => {
  it('keys on type and normalised name and unit, question or title', () => {
    expect(entityKey(product(2600, 'inclusive', '  Pandan  CHIFFON cake', '20  cm'))).toBe(
      'product:pandan chiffon cake|20 cm',
    );
    expect(entityKey(product(2600, 'inclusive', 'Pandan chiffon cake', '1 kg'))).not.toBe(
      entityKey(product(2600)),
    );
    expect(entityKey(faq('Yes'))).toBe('faq:can i collect on sundays?');
    expect(entityKey(policy('x'))).toBe('policy:refund policy');
    expect(entityKey(promotion('x'))).toBe('promotion:christmas log cake');
  });

  it('gives a stable 16-hex ID per key', () => {
    expect(conflictId('product:a|')).toMatch(/^[0-9a-f]{16}$/);
    expect(conflictId('product:a|')).toBe(conflictId('product:a|'));
    expect(conflictId('product:a|')).not.toBe(conflictId('product:b|'));
  });
});

describe('sameValue (D2)', () => {
  it('compares prices exactly, and GST unknown agrees with either treatment', () => {
    expect(sameValue(product(2600), product(2600))).toBe(true);
    expect(sameValue(product(2600), product(2850))).toBe(false);
    expect(sameValue(product(2600, 'unknown'), product(2600, 'inclusive'))).toBe(true);
    expect(sameValue(product(2600, 'exclusive'), product(2600, 'unknown'))).toBe(true);
    expect(sameValue(product(2600, 'inclusive'), product(2600, 'exclusive'))).toBe(false);
  });

  it('never matches different entities', () => {
    expect(sameValue(product(2600), product(2600, 'inclusive', 'Butter cake'))).toBe(false);
    expect(
      sameValue(product(2600), product(2600, 'inclusive', 'Pandan chiffon cake', '1 kg')),
    ).toBe(false);
  });

  it('compares promotion price, dates and details', () => {
    expect(sameValue(promotion('15% off'), promotion('15%  OFF'))).toBe(true);
    expect(sameValue(promotion('15% off'), promotion('20% off'))).toBe(false);
    expect(sameValue(promotion('15% off'), promotion('15% off', '2026-12-31'))).toBe(false);
    expect(sameValue(promotion('15% off', '2026-12-26', 3000), promotion('15% off'))).toBe(false);
    expect(
      sameValue(promotion('15% off', '2026-12-26', 3000), promotion('15% off', '2026-12-26', 3000)),
    ).toBe(true);
  });

  it('compares policy and FAQ texts up to case and whitespace', () => {
    expect(sameValue(policy('Cancel 2 days ahead.'), policy('cancel  2 days ahead.'))).toBe(true);
    expect(sameValue(policy('Cancel 2 days ahead.'), policy('Cancel 3 days ahead.'))).toBe(false);
    expect(
      sameValue(policy('Cancel 2 days ahead.'), policy('Cancel 2 days ahead.', 'delivery')),
    ).toBe(false);
    expect(sameValue(faq('Yes, 9 am to 1 pm.'), faq('YES, 9 am to 1 pm.'))).toBe(true);
    expect(sameValue(faq('Yes, 9 am to 1 pm.'), faq('No.'))).toBe(false);
  });
});

describe('planPromotion (FEAT-014 §5.2)', () => {
  const c = (input: FactInput, tag: string) => ({ input, tag });
  const e = (
    input: FactInput,
    status: ExistingFact['status'],
    id: string = status,
  ): ExistingFact => ({
    id,
    status,
    version: 1,
    input,
  });

  it('writes a lone new finding for review, as before', () => {
    const plan = planPromotion([c(product(2850), 'a')], []);
    expect(plan.insert.map((i) => [i.candidate.tag, i.status])).toEqual([['a', 'needs_review']]);
    expect(plan.flag).toEqual([]);
  });

  it('collapses agreeing findings within the run, keeping the first', () => {
    const plan = planPromotion([c(product(2850), 'a'), c(product(2850, 'unknown'), 'b')], []);
    expect(plan.insert.map((i) => [i.candidate.tag, i.status])).toEqual([['a', 'needs_review']]);
  });

  it('keeps both of two disagreeing findings in one run, conflicted (AC-2)', () => {
    const plan = planPromotion(
      [
        c(product(2850), 'a'),
        c(product(2600), 'b'),
        c(product(1500, 'inclusive', 'Butter cake'), 'x'),
      ],
      [],
    );
    expect(plan.insert.map((i) => [i.candidate.tag, i.status])).toEqual([
      ['a', 'conflicted'],
      ['b', 'conflicted'],
      ['x', 'needs_review'],
    ]);
  });

  it('flags live facts a finding disagrees with (AC-1)', () => {
    const approved = e(product(2600), 'approved');
    const review = e(product(2700), 'needs_review');
    const plan = planPromotion([c(product(2850), 'a')], [approved, review]);
    expect(plan.insert.map((i) => i.status)).toEqual(['conflicted']);
    expect(plan.flag.map((f) => f.id)).toEqual(['approved', 'needs_review']);
  });

  it('joins an open conflict without flagging its facts again', () => {
    const plan = planPromotion(
      [c(product(3000), 'a')],
      [e(product(2600), 'conflicted', 'x'), e(product(2850), 'conflicted', 'y')],
    );
    expect(plan.insert.map((i) => i.status)).toEqual(['conflicted']);
    expect(plan.flag).toEqual([]);
  });

  it.each(['approved', 'needs_review', 'conflicted', 'rejected', 'disabled'] as const)(
    'drops a finding that agrees with a %s fact (D3, AC-3)',
    (status) => {
      const plan = planPromotion([c(product(2600, 'unknown'), 'a')], [e(product(2600), status)]);
      expect(plan.insert).toEqual([]);
      expect(plan.flag).toEqual([]);
    },
  );

  it('never joins rejected or disabled facts to a conflict (D3)', () => {
    const plan = planPromotion(
      [c(product(2850), 'a')],
      [e(product(2600), 'rejected', 'r'), e(product(2700), 'disabled', 'd')],
    );
    expect(plan.insert.map((i) => i.status)).toEqual(['needs_review']);
    expect(plan.flag).toEqual([]);
  });

  it('treats inclusive against exclusive at one price as a conflict', () => {
    const plan = planPromotion(
      [c(product(2600, 'exclusive'), 'a')],
      [e(product(2600), 'approved')],
    );
    expect(plan.insert.map((i) => i.status)).toEqual(['conflicted']);
    expect(plan.flag.map((f) => f.id)).toEqual(['approved']);
  });

  it('leaves other entities alone', () => {
    const plan = planPromotion(
      [c(product(2850), 'a')],
      [
        e(product(2600, 'inclusive', 'Pandan chiffon cake', '1 kg'), 'approved'),
        e(faq('Yes'), 'approved', 'q'),
      ],
    );
    expect(plan.insert.map((i) => i.status)).toEqual(['needs_review']);
    expect(plan.flag).toEqual([]);
  });
});
