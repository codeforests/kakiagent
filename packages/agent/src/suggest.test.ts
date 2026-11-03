import { describe, expect, it } from 'vitest';
import { suggestionOutcome } from './suggest.js';

describe('suggestionOutcome (FEAT-045 §5.1 step 4)', () => {
  it('only an answered turn gives a draft', () => {
    expect(suggestionOutcome('answered')).toBe('ready');
    for (const o of ['escalated', 'unsure', 'out_of_scope', 'refused', 'ended'] as const)
      expect(suggestionOutcome(o)).toBe('no_checked_answer');
    expect(suggestionOutcome('unavailable')).toBe('unavailable');
    expect(suggestionOutcome('none')).toBe('unavailable');
  });
});
