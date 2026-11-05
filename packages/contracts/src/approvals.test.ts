import { describe, expect, it } from 'vitest';
import {
  AlreadyDecided,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalList,
  ApprovalTerms,
  MessageCard,
  RealtimeEvent,
  TurnQueueJob,
} from './index.js';
import { formatSgd, totalsOf } from './quote.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-05T02:00:00.000Z';
const line = {
  factId: ID,
  factVersion: 2,
  label: 'Vanilla cupcake',
  unit: 'piece',
  quantity: 200,
  unitPriceCents: 350,
};
const terms = { lines: [line], discountPct: 15, note: 'Delivery on Friday is fine.' };
const totals = {
  subtotalCents: 70_000,
  discountCents: 10_500,
  totalCents: 59_500,
  gst: 'inclusive',
};
const summary = {
  id: ID,
  kind: 'discount',
  status: 'pending',
  conversationId: ID,
  contactName: null,
  headline: '200 × Vanilla cupcake · 15% off',
  totalCents: 59_500,
  createdAt: AT,
  slaDueAt: AT,
  expiresAt: AT,
  urgent: false,
  breached: false,
  afterHours: true,
  aboveMaxDiscount: true,
};
const detail = {
  ...summary,
  request: { items: 'cupcakes', quantity: '200', date: null, discountPct: 15 },
  draft: terms,
  draftTotals: totals,
  final: null,
  finalTotals: null,
  prices: [
    {
      factId: ID,
      version: 2,
      name: 'Vanilla cupcake',
      priceCents: 350,
      unit: 'piece',
      current: true,
    },
  ],
  excerpt: [],
  maxDiscountPct: 10,
  decision: null,
  version: 1,
  canDecide: true,
};

describe('approvals contracts (FEAT-055 §3)', () => {
  it('round-trips a list, a detail, a 409 body, a quote card, an event and a timer job', () => {
    expect(
      ApprovalList.parse({ items: [summary], nextCursor: null, pendingCount: 1 }).items,
    ).toEqual([summary]);
    expect(ApprovalDetail.parse(detail)).toEqual(detail);
    const decided = {
      ...detail,
      status: 'approved',
      final: terms,
      finalTotals: totals,
      canDecide: false,
      decision: { by: { userId: ID, name: 'Mei' }, at: AT, reason: null },
    };
    expect(AlreadyDecided.parse({ error: 'already_decided', approval: decided }).approval).toEqual(
      decided,
    );
    const card = { kind: 'quote', approvalId: ID, ...terms, totals };
    expect(MessageCard.parse(card)).toEqual(card);
    expect(RealtimeEvent.parse({ type: 'approval', id: ID, status: 'expired' })).toEqual({
      type: 'approval',
      id: ID,
      status: 'expired',
    });
    const job = { kind: 'approval_timer', tenantId: ID, approvalId: ID, timer: 'sla' };
    expect(TurnQueueJob.parse(job)).toEqual(job);
  });

  it('ApprovalTerms refuses extra keys, a 21st line and bad numbers', () => {
    expect(ApprovalTerms.safeParse({ ...terms, total: 1 }).success).toBe(false);
    expect(ApprovalTerms.safeParse({ ...terms, lines: [{ ...line, extra: 1 }] }).success).toBe(
      false,
    );
    expect(ApprovalTerms.safeParse({ ...terms, lines: Array(21).fill(line) }).success).toBe(false);
    expect(ApprovalTerms.safeParse({ ...terms, lines: Array(20).fill(line) }).success).toBe(true);
    expect(ApprovalTerms.safeParse({ ...terms, discountPct: 101 }).success).toBe(false);
    expect(ApprovalTerms.safeParse({ ...terms, lines: [{ ...line, quantity: 0 }] }).success).toBe(
      false,
    );
    expect(
      ApprovalTerms.safeParse({ ...terms, lines: [{ ...line, unitPriceCents: 1.5 }] }).success,
    ).toBe(false);
    expect(ApprovalTerms.safeParse({ ...terms, note: 'x'.repeat(501) }).success).toBe(false);
  });

  it('ApprovalDecision needs a reason to reject and terms to edit', () => {
    expect(ApprovalDecision.parse({ action: 'approve', version: 1 })).toEqual({
      action: 'approve',
      version: 1,
    });
    expect(
      ApprovalDecision.safeParse({ action: 'reject', version: 1, reason: '   ' }).success,
    ).toBe(false);
    expect(ApprovalDecision.safeParse({ action: 'reject', version: 1 }).success).toBe(false);
    expect(ApprovalDecision.parse({ action: 'reject', version: 1, reason: ' Sold out ' })).toEqual({
      action: 'reject',
      version: 1,
      reason: 'Sold out',
    });
    expect(ApprovalDecision.safeParse({ action: 'edit_approve', version: 1 }).success).toBe(false);
    expect(ApprovalDecision.safeParse({ action: 'approve', version: 1, terms }).success).toBe(
      false,
    );
  });
});

describe('totalsOf and formatSgd (@kaki/contracts/quote)', () => {
  it.each([
    // [lines, pct, subtotal, discount, total]
    [[{ quantity: 1, unitPriceCents: 705 }], 15, 705, 106, 599], // 105.75 rounds half up to 106
    [[{ quantity: 2, unitPriceCents: 705 }], 15, 1_410, 212, 1_198], // 211.5 → 212
    [[{ quantity: 200, unitPriceCents: 350 }], 0, 70_000, 0, 70_000],
    [[{ quantity: 3, unitPriceCents: 999 }], 100, 2_997, 2_997, 0],
    [[], 15, 0, 0, 0],
    [
      [
        { quantity: 2, unitPriceCents: 450 },
        { quantity: 1, unitPriceCents: 1_000 },
      ],
      10,
      1_900,
      190,
      1_710,
    ],
  ])('%j at %i%%', (lines, pct, subtotal, discount, total) => {
    expect(totalsOf({ lines, discountPct: pct }, 'none')).toEqual({
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: total,
      gst: 'none',
    });
  });

  it('formats SGD with thousands separators and a minus', () => {
    expect(formatSgd(59_500)).toBe('S$595.00');
    expect(formatSgd(123_456_7)).toBe('S$12,345.67');
    expect(formatSgd(5)).toBe('S$0.05');
    expect(formatSgd(-10_500)).toBe('-S$105.00');
  });
});
