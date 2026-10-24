import {
  CorrectionAccept,
  CorrectionItem,
  CorrectionReplay,
  ReviewIntervals,
} from '@kaki/contracts';
import { describe, expect, it } from 'vitest';

const FACT = '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a02';
const item = {
  id: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a01',
  status: 'open',
  source: 'stale',
  proposedBy: 'system',
  change: {
    kind: 'reconfirm',
    factId: FACT,
    factVersion: 3,
    factType: 'product',
    label: 'Pandan cake',
    lastConfirmedAt: '2026-03-01T00:00:00.000Z',
  },
  acceptedChange: null,
  facts: [
    {
      id: FACT,
      label: 'Pandan cake',
      type: 'product',
      status: 'approved',
      version: 3,
      lastConfirmedAt: '2026-03-01T00:00:00.000Z',
      overdue: true,
    },
  ],
  coachingSessionId: null,
  conversationId: null,
  createdAt: '2026-10-24T00:00:00.000Z',
  decidedAt: null,
  closedBySystem: false,
};
const replay = {
  status: 'replaying',
  matched: 25,
  turns: [
    {
      messageId: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a03',
      conversationId: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a04',
      index: 0,
      question: 'How much is the pandan cake?',
      askedAt: '2026-10-20T03:00:00.000Z',
      original: [
        {
          author: 'agent',
          text: 'The pandan cake is S$28.',
          factIds: [FACT],
          createdAt: '2026-10-20T03:00:05.000Z',
        },
      ],
      status: 'pending',
      replayed: null,
      effects: [],
      answerChanged: null,
    },
  ],
};

describe('corrections contracts (FEAT-018 §3)', () => {
  it('parses a stale item and a replay', () => {
    expect(CorrectionItem.parse(item)).toEqual(item);
    expect(CorrectionReplay.parse(replay)).toEqual(replay);
  });

  it('rejects a done turn without its answer', () => {
    const turn = { ...replay.turns[0]!, status: 'done' };
    expect(CorrectionReplay.safeParse({ ...replay, turns: [turn] }).success).toBe(false);
  });

  it('takes review intervals of 1 to 24 whole months', () => {
    const ok = { product: 1, faq: 6, policy: 12, promotion: 24 };
    expect(ReviewIntervals.parse(ok)).toEqual(ok);
    for (const bad of [0, 25, 2.5])
      expect(ReviewIntervals.safeParse({ ...ok, faq: bad }).success).toBe(false);
    expect(ReviewIntervals.safeParse({ product: 6, faq: 6, policy: 6 }).success).toBe(false);
  });

  it('accepts a fact or FAQ edit and rejects an hours edit', () => {
    expect(
      CorrectionAccept.safeParse({
        edit: {
          kind: 'edit_fact',
          after: {
            value: { name: 'Pandan cake', priceCents: 3000 },
            gstTreatment: 'inclusive',
            validFrom: null,
            validUntil: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(CorrectionAccept.safeParse({ edit: null }).success).toBe(true);
    expect(
      CorrectionAccept.safeParse({ edit: { kind: 'edit_hours', after: { mon: [] } } }).success,
    ).toBe(false);
  });
});
