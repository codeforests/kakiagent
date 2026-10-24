import type {
  CorrectionItem,
  CorrectionReplay,
  CorrectionReplayNextResponse,
  CorrectionReplayTurn,
  ProposedChange,
} from '@kaki/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import {
  acceptedLine,
  agoLabel,
  closedLine,
  correctionCompleteLine,
  correctionPending,
  correctionProgress,
  correctionRows,
  decisionLabel,
  draftOf,
  effectiveChange,
  factEdit,
  fixSummary,
  gapMeta,
  intervalError,
  isGap,
  itemSummary,
  matchedCaption,
  monthsSince,
  noReplayCaption,
  pastAnswersLede,
  SOURCE_LABEL,
  sourceTone,
  staleLine,
  withCorrectionTurn,
} from './corrections.ts';
import { driveReplay } from './replay.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-24T04:00:00.000Z');

const priceEdit: ProposedChange = {
  kind: 'edit_fact',
  factId: id(1),
  factVersion: 2,
  factType: 'product',
  label: 'Chocolate fudge 1 kg',
  before: {
    value: { name: 'Chocolate fudge 1 kg', price: '52.00' },
    gstTreatment: 'inclusive',
    validFrom: null,
    validUntil: null,
  },
  after: {
    value: { name: 'Chocolate fudge 1 kg', price: '58.00' },
    gstTreatment: 'inclusive',
    validFrom: null,
    validUntil: null,
  },
};
const faq: ProposedChange = {
  kind: 'add_faq',
  question: 'Do you deliver on Sundays?',
  answer: 'Yes, from 10 am.',
};
const hours: ProposedChange = {
  kind: 'edit_hours',
  profileVersion: 3,
  before: { sun: [], sat: [{ open: '09:00', close: '17:00' }] },
  after: { sun: [{ open: '10:00', close: '14:00' }], sat: [{ open: '10:00', close: '18:00' }] },
};
const reconfirm: ProposedChange = {
  kind: 'reconfirm',
  factId: id(1),
  factVersion: 2,
  factType: 'product',
  label: 'Chocolate fudge 1 kg',
  lastConfirmedAt: '2026-03-20T04:00:00.000Z',
};

const item = (over: Partial<CorrectionItem> = {}): CorrectionItem => ({
  id: id(9),
  status: 'open',
  source: 'coaching',
  proposedBy: 'coaching',
  change: priceEdit,
  acceptedChange: null,
  facts: [],
  coachingSessionId: null,
  conversationId: null,
  createdAt: '2026-10-23T04:00:00.000Z',
  decidedAt: null,
  closedBySystem: false,
  gap: null,
  ...over,
});

const turn = (index: number, over: Partial<CorrectionReplayTurn> = {}): CorrectionReplayTurn => ({
  messageId: id(index + 100),
  conversationId: id(index + 200),
  index,
  question: `Question ${index + 1}`,
  askedAt: '2026-10-20T03:00:00.000Z',
  original: [],
  status: 'pending',
  replayed: null,
  effects: [],
  answerChanged: null,
  ...over,
});
const done = (index: number, changed: boolean) =>
  turn(index, {
    status: 'done',
    answerChanged: changed,
    replayed: {
      id: id(index + 300),
      seq: 1,
      author: 'agent',
      kind: 'answer',
      text: 'Now S$58.00.',
      explainer: null,
      correction: null,
      createdAt: '2026-10-24T04:00:00.000Z',
    } as unknown as CorrectionReplayTurn['replayed'],
  });

describe('origin labels', () => {
  it('names every source, overdue items in warning', () => {
    expect(SOURCE_LABEL.coaching).toBe('Coaching');
    expect(SOURCE_LABEL.stale).toBe('Overdue for review');
    expect(SOURCE_LABEL.thumbs_down).toBe('Visitor 👎');
    expect(Object.keys(SOURCE_LABEL)).toHaveLength(7);
    expect(sourceTone('stale')).toBe('warning');
    expect(sourceTone('coaching')).toBe('neutral');
  });
});

describe('diff rows and summaries per change kind', () => {
  it('edit_fact: a price row, struck "Was" and "Now"', () => {
    expect(correctionRows(priceEdit)).toEqual([
      { label: 'Price', was: 'S$52.00 · GST incl.', now: 'S$58.00 · GST incl.' },
    ]);
    expect(fixSummary(priceEdit, NOW)).toBe(
      'Price of Chocolate fudge 1 kg: S$52.00 · GST incl. → S$58.00 · GST incl.',
    );
  });
  it('add_faq: question and answer, nothing struck', () => {
    expect(correctionRows(faq)).toEqual([
      { label: 'Question', was: null, now: 'Do you deliver on Sundays?' },
      { label: 'Answer', was: null, now: 'Yes, from 10 am.' },
    ]);
    expect(fixSummary(faq)).toBe('New FAQ: Do you deliver on Sundays?');
  });
  it('edit_hours: one row per changed day, in week order', () => {
    const rows = correctionRows(hours);
    expect(rows.map((r) => r.label)).toEqual(['Saturday', 'Sunday']);
    expect(rows[1]).toEqual({ label: 'Sunday', was: 'Sun closed', now: 'Sun 10:00 am – 2:00 pm' });
    expect(fixSummary(hours)).toBe('Opening hours for Sat, Sun');
  });
  it('reconfirm: no rows, the age in the summary', () => {
    expect(correctionRows(reconfirm)).toEqual([]);
    expect(fixSummary(reconfirm, NOW)).toBe(
      'Re-confirm: Chocolate fudge 1 kg, last confirmed 7 months ago',
    );
    expect(acceptedLine(reconfirm)).toBe('Re-confirmed. The review clock restarts today.');
    expect(acceptedLine(priceEdit)).toBe('Fix accepted. Your assistant now uses it.');
  });
  it('says why no comparison appears (D3)', () => {
    expect(noReplayCaption(faq)).toMatch(/No past answers used this yet/);
    expect(noReplayCaption(hours)).toMatch(/Opening-hours answers/);
    expect(noReplayCaption(priceEdit)).toBe('No customer has asked about this fact yet.');
    expect(noReplayCaption(reconfirm)).toBeNull();
  });
});

describe('effective change and decisions', () => {
  it('uses the accepted edit when the fix was edited (D7)', () => {
    const edited = { ...priceEdit, after: { ...priceEdit.after, value: { price: '60.00' } } };
    expect(effectiveChange(item())).toBe(priceEdit);
    expect(effectiveChange(item({ status: 'edited_and_accepted', acceptedChange: edited }))).toBe(
      edited,
    );
  });
  it('labels each decision, the scan auto-close apart (D8)', () => {
    expect(decisionLabel(item({ status: 'accepted' }))).toBe('Accepted');
    expect(decisionLabel(item({ status: 'edited_and_accepted' }))).toBe('Edited and accepted');
    expect(decisionLabel(item({ status: 'dismissed' }))).toBe('Closed');
    expect(decisionLabel(item({ status: 'dismissed', closedBySystem: true }))).toBe(
      'Closed automatically',
    );
  });
});

describe('coverage gap items (FEAT-019)', () => {
  const gapChange: ProposedChange = { kind: 'answer_gap' };
  const gapItem = (over: Partial<CorrectionItem> = {}) =>
    item({
      source: 'coverage_gap',
      proposedBy: 'system',
      change: gapChange,
      gap: { question: 'Do you deliver to Jurong?', asksTotal: 5 },
      ...over,
    });
  it('labels the origin and reads as the customers’ question while open', () => {
    expect(SOURCE_LABEL.coverage_gap).toBe('Coverage gap');
    expect(isGap(gapItem())).toBe(true);
    expect(isGap(item())).toBe(false);
    expect(itemSummary(gapItem())).toBe('Customers asked: “Do you deliver to Jurong?”');
    expect(gapMeta(gapItem())).toBe('5 times');
    expect(gapMeta(gapItem({ gap: { question: 'Halal?', asksTotal: 1 } }))).toBe('once');
    expect(gapMeta(item())).toBeNull();
    expect(itemSummary(item(), NOW)).toBe(fixSummary(priceEdit, NOW));
  });
  it('falls back to a generic line without its question', () => {
    expect(itemSummary(gapItem({ gap: null }))).toMatch(/^Customers asked something/);
  });
  it('an accepted gap shows the FAQ it added', () => {
    const accepted = gapItem({ status: 'edited_and_accepted', acceptedChange: faq });
    expect(effectiveChange(accepted)).toBe(faq);
    expect(itemSummary(accepted)).toBe('New FAQ: Do you deliver on Sundays?');
    expect(decisionLabel(accepted)).toBe('FAQ added');
    expect(acceptedLine(faq, gapChange)).toBe('FAQ added. Your assistant now uses it.');
    expect(noReplayCaption(faq)).toMatch(/No past answers used this yet/);
    expect(noReplayCaption(gapChange)).toMatch(/No past answers used this yet/);
  });
  it('says why a gap closed by itself', () => {
    const auto = gapItem({ status: 'dismissed', closedBySystem: true });
    expect(decisionLabel(auto)).toBe('Closed automatically');
    expect(closedLine(auto, null)).toBe(
      'Closed automatically: the chats it came from were deleted.',
    );
    expect(closedLine(item({ status: 'dismissed', closedBySystem: true }), null)).toMatch(
      /the fact was confirmed or changed since/,
    );
    expect(closedLine(gapItem({ status: 'dismissed' }), '2 hours ago')).toBe(
      'Closed 2 hours ago. Nothing in your knowledge changed.',
    );
  });
});

describe('stale clock', () => {
  it('counts whole months and days', () => {
    expect(monthsSince('2026-03-20T04:00:00.000Z', NOW)).toBe(7);
    expect(monthsSince('2026-09-25T04:00:00.000Z', NOW)).toBe(0);
    expect(agoLabel('2026-10-21T04:00:00.000Z', NOW)).toBe('3 days ago');
    expect(agoLabel('2026-09-24T04:00:00.000Z', NOW)).toBe('1 month ago');
  });
  it('states the interval for the type', () => {
    expect(
      staleLine(
        '2026-03-20T04:00:00.000Z',
        'product',
        { product: 6, faq: 6, policy: 6, promotion: 6 },
        NOW,
      ),
    ).toBe('Last confirmed 20 Mar 2026, 7 months ago. Your interval for products is 6 months.');
  });
  it('accepts 1 to 24 months only', () => {
    expect(intervalError('6')).toBeUndefined();
    expect(intervalError('24')).toBeUndefined();
    for (const bad of ['0', '25', '', '3.5', 'six'])
      expect(intervalError(bad)).toBe('Enter 1 to 24 months.');
  });
});

describe('replay copy', () => {
  const replay = (turns: CorrectionReplayTurn[], matched = turns.length): CorrectionReplay => ({
    status: 'replaying',
    matched,
    turns,
  });
  it('"{k} of {n}" progress and completion', () => {
    const turns = [done(0, true), done(1, false), turn(2)];
    expect(correctionProgress(turns)).toBe('Replaying 2 of 3…');
    expect(correctionCompleteLine([done(0, true), done(1, false)])).toBe(
      'Replay complete. 1 answer changed.',
    );
    expect(correctionCompleteLine([done(0, true), done(1, true)])).toBe(
      'Replay complete. 2 answers changed.',
    );
  });
  it('the lede and the 20-of-matched caption (D4)', () => {
    expect(pastAnswersLede(12)).toBe(
      "12 recent customer questions used this fact. Here's what they got and what your assistant says now.",
    );
    expect(matchedCaption(replay([turn(0), turn(1)], 34))).toBe('The 2 most recent of 34.');
    expect(matchedCaption(replay([turn(0), turn(1)]))).toBeNull();
  });
  it('swaps in an answered turn and completes on the last', () => {
    const r = replay([done(0, false), turn(1)]);
    expect(correctionPending(r)).toBe(true);
    const next = withCorrectionTurn(r, done(1, true));
    expect(correctionPending(next)).toBe(false);
    expect(next.status).toBe('complete');
  });
});

describe('the drive loop on correction replays', () => {
  const res = (index: number, remaining: number): CorrectionReplayNextResponse => ({
    turn: done(index, false),
    remaining,
  });
  it('stops on an error and reports it', async () => {
    const next = vi
      .fn<() => Promise<CorrectionReplayNextResponse>>()
      .mockResolvedValueOnce(res(0, 2))
      .mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    const onTurn = vi.fn();
    expect(await driveReplay(next, onTurn, () => false)).toEqual({
      kind: 'error',
      failure: 'failed',
    });
    expect(next).toHaveBeenCalledTimes(2);
    expect(onTurn).toHaveBeenCalledTimes(1);
  });
  it('stops on a 429 as rate limited', async () => {
    const next = vi.fn().mockRejectedValue(new ApiError(429, 'rate_limited', 'slow'));
    expect(await driveReplay(next, vi.fn(), () => false)).toEqual({
      kind: 'error',
      failure: 'rate_limited',
    });
  });
  it('stops after the call in flight when paused', async () => {
    let paused = false;
    const next = vi.fn(async () => {
      paused = true;
      return res(0, 5);
    });
    expect(await driveReplay(next, vi.fn(), () => paused)).toEqual({ kind: 'paused' });
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('ends when nothing remains', async () => {
    const next = vi.fn().mockResolvedValueOnce(res(0, 1)).mockResolvedValueOnce(res(1, 0));
    expect(await driveReplay(next, vi.fn(), () => false)).toEqual({ kind: 'done' });
  });
});

describe('edit bodies', () => {
  it('round-trips a proposed price through the dialog draft', () => {
    const d = draftOf('product', priceEdit.after);
    expect(d.price).toBe('58.00');
    expect(factEdit({ ...d, price: '60' }, priceEdit.after)).toEqual({
      kind: 'edit_fact',
      after: {
        value: { name: 'Chocolate fudge 1 kg', price: '60.00', unit: undefined },
        gstTreatment: 'inclusive',
        validFrom: null,
        validUntil: null,
      },
    });
  });
});
