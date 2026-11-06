import { describe, expect, it } from 'vitest';
import { bandOf, matchKeyword, parseBudget, scoreLead, type ScoreInput } from './score.js';

const none: ScoreInput = {
  need: null,
  budget: null,
  preferredTime: null,
  hasPhone: false,
  hasEmail: false,
  wantsToOrder: false,
  returning: false,
};
const q = { keywords: ['wedding', '婚礼'], minBudget: 300 };

describe('scoreLead (FEAT-050 §5.1; AC-1)', () => {
  it.each([
    [
      'keyword',
      { need: 'A wedding cake' },
      [
        ['keyword', 2, 'wedding'],
        ['need_given', 1, null],
      ],
    ],
    ['budget met', { budget: 'S$500' }, [['budget_met', 2, '300']]],
    ['budget below', { budget: '$100' }, [['budget_below', 0, '300']]],
    ['wants to order', { wantsToOrder: true }, [['wants_to_order', 2, null]]],
    ['both contacts', { hasPhone: true, hasEmail: true }, [['both_contacts', 1, null]]],
    ['one contact only', { hasPhone: true }, []],
    ['need', { need: 'Cupcakes' }, [['need_given', 1, null]]],
    ['timing', { preferredTime: 'Sat 3pm' }, [['timing_given', 1, null]]],
    ['returning', { returning: true }, [['returning', 1, null]]],
    ['unparseable budget', { budget: 'flexible' }, []],
  ] as const)('%s alone', (_, over, want) => {
    const s = scoreLead({ ...none, ...over }, q);
    expect(s.reasons.map((r) => [r.code, r.points, r.detail])).toEqual(want);
    expect(s.points).toBe(want.reduce((n, r) => n + r[1], 0));
  });

  it('no budget criterion gives no budget reason', () => {
    expect(
      scoreLead({ ...none, budget: 'S$500' }, { keywords: [], minBudget: null }).reasons,
    ).toEqual([]);
  });

  it('bands at 2, 3, 4 and 5 points', () => {
    expect([0, 2, 3, 4, 5, 9].map(bandOf)).toEqual(['cold', 'cold', 'warm', 'warm', 'hot', 'hot']);
    const hot = scoreLead(
      { ...none, need: '婚礼蛋糕', budget: '预算3000', hasPhone: true, hasEmail: true },
      q,
    );
    expect(hot).toMatchObject({ score: 'hot', points: 6 });
    expect(hot.reasons.map((r) => r.code)).toEqual([
      'keyword',
      'budget_met',
      'both_contacts',
      'need_given',
    ]);
    expect(
      scoreLead({ ...none, need: 'cake', preferredTime: 'Sat', returning: true }, q).score,
    ).toBe('warm');
  });
});

describe('parseBudget', () => {
  it.each([
    ['S$500', 500],
    ['abt 2k', 2000],
    ['1,200-1,500', 1500],
    ['预算3000', 3000],
    ['3万', 30000],
    ['SGD 1.5k', 1500],
    ['$80.50', 81],
    ['flexible', null],
    ['', null],
  ])('%s → %s', (text, want) => expect(parseBudget(text)).toBe(want));
});

describe('matchKeyword', () => {
  it('Latin on word boundaries, CJK by substring, case-folded', () => {
    expect(matchKeyword('An EVENT for 50', ['event'])).toBe('event');
    expect(matchKeyword('to prevent stale cake', ['event'])).toBeNull();
    expect(matchKeyword('我们的婚礼需要蛋糕', ['婚礼'])).toBe('婚礼');
    expect(matchKeyword('Corporate order', ['wedding', 'corporate'])).toBe('corporate');
    expect(matchKeyword(null, ['x'])).toBeNull();
  });
});
