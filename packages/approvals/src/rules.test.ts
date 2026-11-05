import {
  BoundaryRules as BoundaryRulesContract,
  COMMITMENT_KEYS as CONTRACT_KEYS,
} from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  changedFields,
  COMMITMENT_KEYS,
  commitmentDecision,
  normaliseList,
  normaliseRules,
  SAFE_DEFAULTS,
  type BoundaryRules,
} from './rules.js';

describe('the contract (FEAT-054 §3; moved here in FEAT-055)', () => {
  it('has the same keys and commitment codes as the contracts', () => {
    expect(Object.keys(BoundaryRulesContract.shape).sort()).toEqual(
      Object.keys(SAFE_DEFAULTS).sort(),
    );
    expect([...COMMITMENT_KEYS]).toEqual([...CONTRACT_KEYS]);
    expect(BoundaryRulesContract.parse(SAFE_DEFAULTS)).toEqual(SAFE_DEFAULTS);
  });
});

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
    // FEAT-055 D1: above the maximum goes to approval (flagged), never refused or allowed.
    [{ maxDiscountPct: 0, quotesNeedApproval: true }, { discountPct: 5 }, 'needs_approval'],
    [{ maxDiscountPct: 10, quotesNeedApproval: true }, { discountPct: 11 }, 'needs_approval'],
    [{ maxDiscountPct: 10, quotesNeedApproval: false }, { discountPct: 11 }, 'needs_approval'],
    [{ maxDiscountPct: 10, quotesNeedApproval: true }, { discountPct: 10 }, 'needs_approval'],
    [{ maxDiscountPct: 10, quotesNeedApproval: false }, { discountPct: 5 }, 'allowed'],
    [{ maxDiscountPct: 0, quotesNeedApproval: true }, {}, 'needs_approval'],
    [{ maxDiscountPct: 0, quotesNeedApproval: false }, {}, 'allowed'],
  ] as const)('%o with %o → %s', (rules, input, out) => {
    expect(commitmentDecision(rules, input)).toBe(out);
  });
});
