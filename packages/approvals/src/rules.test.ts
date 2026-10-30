import { describe, expect, it } from 'vitest';
import {
  changedFields,
  commitmentDecision,
  normaliseList,
  normaliseRules,
  SAFE_DEFAULTS,
  type BoundaryRules,
} from './rules.js';

describe('normalisation (FEAT-054 §5.1)', () => {
  it('trims, collapses spaces and dedupes without case, keeping the first spelling', () => {
    expect(
      normaliseList(['  Competitor  prices ', 'competitor prices', 'Halal', 'HALAL', ' ']),
    ).toEqual(['Competitor prices', 'Halal']);
  });

  it('always keeps the locked commitments, in key order', () => {
    const r = normaliseRules({ ...SAFE_DEFAULTS, forbiddenCommitments: ['refund'] });
    expect(r.forbiddenCommitments).toEqual(['refund', 'legal_advice', 'medical_advice']);
  });
});

describe('changedFields', () => {
  it('lists codes only for the fields that differ', () => {
    const after: BoundaryRules = {
      ...SAFE_DEFAULTS,
      blockedTopics: ['Politics'],
      maxDiscountPct: 10,
    };
    expect(changedFields(SAFE_DEFAULTS, after)).toEqual(['blocked_topics', 'max_discount']);
    expect(changedFields(after, after)).toEqual([]);
  });
});

describe('commitmentDecision (AC-8)', () => {
  it.each([
    [{ maxDiscountPct: 0, quotesNeedApproval: true }, { discountPct: 5 }, 'refuse'],
    [{ maxDiscountPct: 10, quotesNeedApproval: true }, { discountPct: 11 }, 'refuse'],
    [{ maxDiscountPct: 10, quotesNeedApproval: true }, { discountPct: 10 }, 'needs_approval'],
    [{ maxDiscountPct: 10, quotesNeedApproval: false }, { discountPct: 5 }, 'allowed'],
    [{ maxDiscountPct: 0, quotesNeedApproval: true }, {}, 'needs_approval'],
    [{ maxDiscountPct: 0, quotesNeedApproval: false }, {}, 'allowed'],
  ] as const)('%o with %o → %s', (rules, input, out) => {
    expect(commitmentDecision(rules, input)).toBe(out);
  });
});
