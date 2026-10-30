import { describe, expect, it } from 'vitest';
import { INDUSTRY_TEMPLATES } from './templates.js';

describe('industry templates (FEAT-054 §5.2)', () => {
  it('the F&B template suggests topics, none both allowed and blocked', () => {
    const rules = INDUSTRY_TEMPLATES.fnb?.suggestedRules;
    expect(rules?.allowedTopics.length).toBeGreaterThan(0);
    expect(rules?.blockedTopics.length).toBeGreaterThan(0);
    const allowed = new Set(rules?.allowedTopics.map((t) => t.toLowerCase()));
    expect(rules?.blockedTopics.filter((t) => allowed.has(t.toLowerCase()))).toEqual([]);
    for (const t of [...(rules?.allowedTopics ?? []), ...(rules?.blockedTopics ?? [])])
      expect(t.length).toBeLessThanOrEqual(80);
  });
});
