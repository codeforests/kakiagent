import type { BoundaryRules } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { diffRules, discountError, rulesFieldErrors, savedCaption, topicError } from './rules.ts';

const base: BoundaryRules = {
  allowedTopics: ['Cakes'],
  blockedTopics: [],
  maxDiscountPct: 0,
  quotesNeedApproval: true,
  forbiddenCommitments: ['delivery_guarantee', 'refund', 'legal_advice', 'medical_advice'],
  customCommitments: [],
};

describe('diffRules', () => {
  it('has no lines when nothing changed, even with other spacing or case', () => {
    expect(diffRules(base, { ...base })).toEqual([]);
    expect(diffRules(base, { ...base, allowedTopics: ['  cakes '] })).toEqual([]);
  });

  it('names each field change', () => {
    const after: BoundaryRules = {
      allowedTopics: ['Wedding cakes'],
      blockedTopics: ["Competitors' prices"],
      maxDiscountPct: 10,
      quotesNeedApproval: false,
      forbiddenCommitments: ['delivery_guarantee', 'legal_advice', 'medical_advice'],
      customCommitments: ['Same-day delivery'],
    };
    expect(diffRules(base, after)).toEqual([
      'Helps with: added Wedding cakes',
      'Helps with: removed Cakes',
      "Won't discuss: added Competitors' prices",
      'Never promise: added Same-day delivery',
      'Maximum discount: 0% → 10%',
      'Quotes: no longer need approval',
      'Refunds: no longer forbidden',
    ]);
    expect(
      diffRules(after, {
        ...after,
        quotesNeedApproval: true,
        forbiddenCommitments: base.forbiddenCommitments,
      }),
    ).toEqual(['Quotes: now need approval', 'Refunds: now forbidden']);
  });
});

describe('topicError', () => {
  const opts = { max: 3 };
  it('accepts a new topic', () => {
    expect(topicError(['Cakes'], 'Bread', opts)).toBeUndefined();
  });
  it('refuses an empty, too short or too long topic', () => {
    expect(topicError([], '   ', opts)).toBe('Type something to add.');
    expect(topicError([], 'a', opts)).toBe('Use 2 to 80 characters');
    expect(topicError([], 'x'.repeat(81), opts)).toBe('Use 2 to 80 characters');
    expect(topicError([], 'x'.repeat(80), opts)).toBeUndefined();
  });
  it('refuses a duplicate in any case or spacing', () => {
    expect(topicError(['Wedding cakes'], ' wedding   CAKES ', opts)).toBe('Already in the list');
  });
  it('refuses a topic already in the other list', () => {
    const other = {
      items: ['Halal'],
      message: 'This topic is blocked, so it can’t also be allowed',
    };
    expect(topicError([], 'halal', { ...opts, other })).toBe(other.message);
  });
  it('refuses a topic when the list is full', () => {
    expect(topicError(['a1', 'b2', 'c3'], 'd4', opts)).toBe('You can add up to 3');
  });
});

describe('discountError', () => {
  it('takes whole numbers from 0 to 100', () => {
    for (const ok of ['0', '10', '100', ' 5 ']) expect(discountError(ok)).toBeUndefined();
    for (const bad of ['', '-1', '101', '2.5', 'ten'])
      expect(discountError(bad)).toBe('Enter a whole number from 0 to 100');
  });
});

describe('rulesFieldErrors', () => {
  it('maps the 400 field codes to one message per field', () => {
    expect(
      rulesFieldErrors({
        'rules.blockedTopics.1': 'also_allowed',
        'rules.blockedTopics.2': 'duplicate',
        'rules.allowedTopics': 'too_big',
        'rules.forbiddenCommitments': 'locked',
        'rules.maxDiscountPct': 'too_big',
        body: 'invalid',
      }),
    ).toEqual({
      blockedTopics: "A topic can't be both helped with and not discussed",
      allowedTopics: 'Use 2 to 80 characters, up to 25 items',
      forbiddenCommitments: 'Legal and medical advice are always on',
      maxDiscountPct: 'Enter a whole number from 0 to 100',
    });
  });
});

describe('savedCaption', () => {
  it('shows the save time in Singapore, or not saved yet', () => {
    expect(savedCaption({ savedAt: '2026-10-30T06:05:00.000Z' })).toMatch(
      /^Saved 30 Oct 2026, 2:05\s?pm$/i,
    );
    expect(savedCaption({ savedAt: null })).toBe('Not saved yet');
  });
});
