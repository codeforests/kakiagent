import { describe, expect, it } from 'vitest';
import {
  decisionText,
  durationText,
  editDraftOf,
  liveTotals,
  slaChip,
  termsError,
  type EditDraft,
} from './approvals.ts';

const NOW = new Date('2026-11-18T06:00:00.000Z'); // Wed 2:00 pm SGT
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const sla = (min: number, extra: { breached?: boolean; afterHours?: boolean } = {}) =>
  slaChip({ slaDueAt: at(min), breached: false, afterHours: false, ...extra }, NOW);

describe('slaChip (SCR-APP-017; FEAT-055 AC-5, AC-7)', () => {
  it('is pending from 30 minutes left, urgent below, overdue from 0', () => {
    expect(sla(31)).toEqual({ text: 'Due in 31 min', tone: 'pending' });
    expect(sla(30)).toEqual({ text: 'Due in 30 min', tone: 'pending' });
    expect(sla(29)).toEqual({ text: 'Due in 29 min', tone: 'warning' });
    expect(sla(0)).toEqual({ text: 'Overdue by 0 min', tone: 'danger' });
    expect(sla(-5)).toEqual({ text: 'Overdue by 5 min', tone: 'danger' });
    expect(sla(-5, { breached: true })).toEqual({
      text: 'Overdue by 5 min · escalated',
      tone: 'danger',
    });
  });

  it('reads hours and names the day when the answer is due after hours on another day', () => {
    expect(sla(80)).toEqual({ text: 'Due in 1 h 20 min', tone: 'pending' });
    expect(durationText(120)).toBe('2 h');
    // Mon 23 Nov 10:00 am SGT, five days on.
    const chip = slaChip(
      { slaDueAt: '2026-11-23T02:00:00.000Z', breached: false, afterHours: true },
      NOW,
    );
    expect(chip).toEqual({ text: 'Due Mon 10:00 am', tone: 'pending' });
    // After hours but still today: the countdown.
    expect(sla(90, { afterHours: true }).text).toBe('Due in 1 h 30 min');
  });
});

const draft = (patch: Partial<EditDraft> = {}): EditDraft => ({
  lines: [
    {
      key: 'a',
      factId: '00000000-0000-4000-8000-0000000000f1',
      factVersion: 3,
      unit: 'piece',
      label: 'Vanilla cupcake',
      quantity: '200',
      price: '3.50',
    },
  ],
  discount: '15',
  note: ' Ready Friday. ',
  ...patch,
});

describe('termsError (SCR-APP-018 edit mode; FEAT-055 AC-6)', () => {
  it('turns the inputs into terms in cents, keeping the fact snapshot', () => {
    expect(termsError(draft())).toEqual({
      ok: true,
      terms: {
        lines: [
          {
            factId: '00000000-0000-4000-8000-0000000000f1',
            factVersion: 3,
            label: 'Vanilla cupcake',
            unit: 'piece',
            quantity: 200,
            unitPriceCents: 350,
          },
        ],
        discountPct: 15,
        note: 'Ready Friday.',
      },
    });
    const prices = ['S$3', '1,200.5', '0'].map((price) => {
      const r = termsError(draft({ lines: [{ ...draft().lines[0]!, price }] }));
      return r.ok ? r.terms.lines[0]!.unitPriceCents : null;
    });
    expect(prices).toEqual([300, 120050, 0]);
  });

  it('names each bad field with the ui-design texts', () => {
    const line = draft().lines[0]!;
    const r = termsError({
      lines: [{ ...line, label: ' ', quantity: '0', price: '3.505' }],
      discount: '10.5',
      note: '',
    });
    expect(r).toEqual({
      ok: false,
      errors: {
        'label-a': 'Enter what this line is, up to 120 characters',
        'quantity-a': 'Enter a quantity from 1 to 100,000',
        'price-a': 'Enter a price like 3.50',
        discount: 'Enter a whole number from 0 to 100',
      },
    });
    const big = termsError(draft({ lines: [{ ...line, quantity: '100001' }], discount: '101' }));
    expect(big.ok ? {} : big.errors).toEqual({
      'quantity-a': 'Enter a quantity from 1 to 100,000',
      discount: 'Enter a whole number from 0 to 100',
    });
  });

  it('needs a line or a note; a note alone is a promise', () => {
    expect(termsError(draft({ lines: [], note: '  ' }))).toEqual({
      ok: false,
      errors: { form: 'Add a line or a note before sending' },
    });
    const r = termsError(draft({ lines: [], discount: '', note: 'Delivery on Sunday is fine' }));
    expect(r).toEqual({
      ok: true,
      terms: { lines: [], discountPct: 0, note: 'Delivery on Sunday is fine' },
    });
  });

  it('round-trips a stored draft and totals it live like the server', () => {
    const d = editDraftOf({
      lines: [
        {
          factId: null,
          factVersion: null,
          label: 'Box',
          unit: null,
          quantity: 3,
          unitPriceCents: 1205,
        },
      ],
      discountPct: 10,
      note: '',
    });
    expect(d.lines[0]).toMatchObject({ quantity: '3', price: '12.05' });
    expect(d.discount).toBe('10');
    expect(liveTotals(d, 'inclusive')).toEqual({
      subtotalCents: 3615,
      discountCents: 362,
      totalCents: 3253,
      gst: 'inclusive',
    });
    // Half-typed values count as zero rather than failing.
    expect(liveTotals({ ...d, discount: '1x' }, 'none').discountCents).toBe(0);
  });
});

describe('decisionText (SCR-APP-018 decided states; FEAT-055 AC-8, AC-9)', () => {
  const by = { userId: '00000000-0000-4000-8000-0000000000b1', name: 'Mei Ling' };
  const base = {
    expiresAt: '2026-11-25T06:00:00.000Z',
    decision: { by, at: '2026-11-18T06:02:00.000Z', reason: null },
  };
  it('names who decided first, or me', () => {
    expect(decisionText({ ...base, status: 'pending', decision: null }, null)).toBeNull();
    expect(decisionText({ ...base, status: 'approved' }, null)).toBe(
      'Already approved by Mei Ling at 2:02 pm.',
    );
    expect(decisionText({ ...base, status: 'edited_approved' }, null)).toBe(
      'Already approved with edits by Mei Ling at 2:02 pm.',
    );
    expect(decisionText({ ...base, status: 'edited_approved' }, by.userId)).toBe(
      'You approved this with edits at 2:02 pm.',
    );
    expect(decisionText({ ...base, status: 'rejected' }, by.userId)).toBe(
      'You rejected this at 2:02 pm.',
    );
  });
  it('explains an expired or undelivered request', () => {
    expect(decisionText({ ...base, status: 'expired', decision: null }, null)).toBe(
      'This request expired on 25 Nov 2026. The visitor was told your team will contact them.',
    );
    expect(decisionText({ ...base, status: 'undeliverable' }, null)).toMatch(
      /^Approved, but we couldn't reach the visitor/,
    );
  });
});
