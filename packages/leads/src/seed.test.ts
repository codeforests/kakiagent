import { SEED_LEADS, SEED_QUALIFICATION } from '@kaki/db/setup';
import { describe, expect, it } from 'vitest';
import { scoreLead } from './score.js';

describe('the dev seed leads score as scoreLead would (FEAT-050 §5.7)', () => {
  it.each(SEED_LEADS.map((l) => [l.name, l] as const))('%s', (_, l) => {
    const s = scoreLead(
      {
        need: l.need,
        budget: l.budget,
        preferredTime: l.preferredTime,
        hasPhone: l.phone !== null,
        hasEmail: l.email !== null,
        wantsToOrder: false,
        returning: false,
      },
      SEED_QUALIFICATION,
    );
    expect(s).toEqual(l.score);
  });
});
