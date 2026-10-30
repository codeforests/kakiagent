import { COMMITMENT_KEYS as DOMAIN_KEYS, SAFE_DEFAULTS } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import {
  BoundaryRules,
  BoundaryRulesResponse,
  COMMITMENT_KEYS,
  SaveBoundaryRulesRequest,
} from './index.js';

const rules = {
  allowedTopics: ['Menu and prices'],
  blockedTopics: ["Competitors' prices"],
  maxDiscountPct: 10,
  quotesNeedApproval: true,
  forbiddenCommitments: ['delivery_guarantee', 'legal_advice', 'medical_advice'],
  customCommitments: ['same-day delivery'],
};
const issues = (r: unknown) => {
  const p = BoundaryRules.safeParse(r);
  return p.success ? [] : p.error.issues.map((i) => [i.path.join('.'), i.message]);
};

describe('boundary rules contract (FEAT-054 §3)', () => {
  it('has the same keys and commitment codes as the approvals module', () => {
    expect(Object.keys(BoundaryRules.shape).sort()).toEqual(Object.keys(SAFE_DEFAULTS).sort());
    expect([...COMMITMENT_KEYS]).toEqual([...DOMAIN_KEYS]);
    expect(BoundaryRules.parse(SAFE_DEFAULTS)).toEqual(SAFE_DEFAULTS);
  });

  it('parses a request and a response', () => {
    expect(SaveBoundaryRulesRequest.parse({ version: null, rules }).rules).toEqual(rules);
    const res = { rules, version: 3, savedAt: '2026-10-30T04:00:00.000Z', source: 'saved' };
    expect(BoundaryRulesResponse.parse(res)).toEqual(res);
  });

  it('refuses duplicates, a topic in both lists, a missing locked key and bad numbers (AC-2)', () => {
    expect(issues({ ...rules, allowedTopics: ['Menu', ' menu '] })).toEqual([
      ['allowedTopics.1', 'duplicate'],
    ]);
    expect(issues({ ...rules, blockedTopics: ['menu and PRICES'] })).toEqual([
      ['blockedTopics.0', 'also_allowed'],
    ]);
    expect(issues({ ...rules, forbiddenCommitments: ['legal_advice'] })).toEqual([
      ['forbiddenCommitments', 'locked'],
    ]);
    expect(issues({ ...rules, maxDiscountPct: 101 })[0]?.[0]).toBe('maxDiscountPct');
    expect(issues({ ...rules, maxDiscountPct: 2.5 })[0]?.[0]).toBe('maxDiscountPct');
    expect(issues({ ...rules, allowedTopics: ['x'] })[0]?.[0]).toBe('allowedTopics.0');
    expect(
      issues({ ...rules, forbiddenCommitments: [...rules.forbiddenCommitments, 'free'] }),
    ).not.toEqual([]);
    expect(
      issues({
        ...rules,
        blockedTopics: Array.from({ length: 26 }, (_, i) => `Topic ${i}`),
      })[0]?.[0],
    ).toBe('blockedTopics');
    expect(
      issues({
        ...rules,
        customCommitments: Array.from({ length: 11 }, (_, i) => `Promise ${i}`),
      })[0]?.[0],
    ).toBe('customCommitments');
  });
});
