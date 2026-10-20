/**
 * Policy and promotion facts in the visitor pipeline (FEAT-011 §5 agent; D4; AC-6):
 * slot rendering, the verifier on typed values, the prompt's fact lines and the fake
 * responder.
 */
import type { GenerateRequest } from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import { fakeVisitorResponder } from './fake-responder.js';
import { buildVisitorPrompt, factLine } from './prompt.js';
import { renderSegment } from './render.js';
import { assignRefs } from './slots.js';
import { BUNDLE, EGGLESS, FUDGE, REFUND } from './testing/facts.js';
import { verifySegment } from './verify.js';

const facts = assignRefs([FUDGE, EGGLESS, REFUND, BUNDLE]);
const ref = (id: string) => facts.refOf.get(id)!;
const slot = (id: string, field: string) => `[[f:${ref(id)}.${field}]]`;

function release(raw: string, gstRegistered = true) {
  const r = renderSegment(raw, facts, gstRegistered);
  if (!r.ok) return { ok: false as const, kinds: r.violations.map((v) => v.kind) };
  const v = verifySegment(r.text, r.spans, []);
  return v.ok
    ? { ok: true as const, text: r.text, factIds: r.factIds }
    : { ok: false as const, kinds: v.violations.map((x) => x.kind) };
}

describe('rendering policy and promotion slots (AC-6; KB-15, NFR-10)', () => {
  it("releases a policy's details through its slot, digits included", () => {
    expect(release(`Sure: ${slot(REFUND.id, 'details')}`)).toEqual({
      ok: true,
      text: 'Sure: Cancel at least 2 days before collection for a full refund.',
      factIds: [REFUND.id],
    });
  });

  it('renders a promotion with its GST-inclusive price and end date', () => {
    const raw = `${slot(BUNDLE.id, 'title')}: ${slot(BUNDLE.id, 'details')} (${slot(BUNDLE.id, 'price')}, until ${slot(BUNDLE.id, 'valid_until')})`;
    expect(release(raw)).toMatchObject({
      ok: true,
      text: 'Deepavali kueh bundle: Any 2 boxes of kueh with a free ondeh ondeh box. (S$21.80 incl. GST, until 31 Oct 2026)',
    });
    expect(release(slot(BUNDLE.id, 'price'), false)).toMatchObject({ text: 'S$20.00' });
  });

  it('fails a price slot on an unpriced promotion and a field the type lacks', () => {
    const unpriced = assignRefs([{ ...BUNDLE, value: { title: 'Free candle', details: 'x' } }]);
    const r = renderSegment(`[[f:${unpriced.refOf.get(BUNDLE.id)}.price]]`, unpriced, true);
    expect(r).toMatchObject({ ok: false, violations: [{ kind: 'unknown_field' }] });
    expect(release(slot(REFUND.id, 'price'))).toMatchObject({
      ok: false,
      kinds: ['unknown_field'],
    });
    const open = assignRefs([{ ...BUNDLE, validUntil: null }]);
    expect(
      renderSegment(`[[f:${open.refOf.get(BUNDLE.id)}.valid_until]]`, open, true),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ['a typed refund period', `You can cancel within seven days for a full refund.`],
    ['a typed refund period in digits', `Cancel 2 days before, ${slot(REFUND.id, 'title')} apply.`],
    ['a typed promotion price', `${slot(BUNDLE.id, 'title')} is S$20 now.`],
    ['a typed promotion end date', `${slot(BUNDLE.id, 'title')} runs till 31 Oct.`],
    ['a typed refund term', `${slot(BUNDLE.id, 'title')} comes with a money-back guarantee.`],
  ])('blocks %s', (_name, raw) => {
    expect(release(raw).ok).toBe(false);
  });
});

describe('prompt and fake responder for the new types', () => {
  it('writes machine-readable fact lines with the visitor-facing values', () => {
    expect(factLine('4d4d4d4d', REFUND, true)).toBe(
      '[f:4d4d4d4d] policy | kind: refund | title: Refunds on whole cakes → [[f:4d4d4d4d.title]] | details: Cancel at least 2 days before collection for a full refund. → [[f:4d4d4d4d.details]]',
    );
    expect(factLine('3e3e3e3e', BUNDLE, true)).toBe(
      '[f:3e3e3e3e] promotion | title: Deepavali kueh bundle → [[f:3e3e3e3e.title]] | details: Any 2 boxes of kueh with a free ondeh ondeh box. → [[f:3e3e3e3e.details]] | price: S$21.80 incl. GST → [[f:3e3e3e3e.price]] | until: 31 Oct 2026 → [[f:3e3e3e3e.valid_until]]',
    );
  });

  it('lists the new protected fields in the static system text, the same for every turn', () => {
    const base = {
      businessName: 'Kaki Bakery',
      gstRegistered: true,
      history: [],
      now: new Date('2026-10-20T02:00:00Z'),
      meta: { tenantId: 't' } as GenerateRequest['meta'],
      model: 'reply.simple' as const,
    };
    const one = buildVisitorPrompt({ ...base, facts, ordered: [REFUND, BUNDLE] });
    const two = buildVisitorPrompt({ ...base, facts: assignRefs([FUDGE]), ordered: [FUDGE] });
    expect(one.system).toBe(two.system);
    expect(one.system).toContain('policy: title, details');
    expect(one.system).toContain('promotion: title, details, price, valid_until');
  });

  it('answers a policy and a promotion with slots that render and verify', () => {
    const tail = [factLine(ref(REFUND.id), REFUND, true), factLine(ref(BUNDLE.id), BUNDLE, true)];
    const raw = fakeVisitorResponder({ tail: tail.join('\n') } as GenerateRequest);
    expect(raw).toBe(
      `${slot(REFUND.id, 'details')} ${slot(BUNDLE.id, 'title')}: ${slot(BUNDLE.id, 'details')} (${slot(BUNDLE.id, 'price')}, until ${slot(BUNDLE.id, 'valid_until')})`,
    );
    const out = release(raw);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.factIds.sort()).toEqual([REFUND.id, BUNDLE.id].sort());
  });
});
