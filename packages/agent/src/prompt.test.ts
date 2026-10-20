import { describe, expect, it } from 'vitest';
import { buildVisitorPrompt, sgtNow } from './prompt.js';
import { assignRefs } from './slots.js';
import { EGGLESS, FUDGE } from './testing/facts.js';

const meta = { tenantId: '11111111-1111-4111-8111-111111111111' };
const turn = (
  facts: (typeof FUDGE)[],
  history: { role: 'user' | 'assistant'; content: string }[],
  now: Date,
) =>
  buildVisitorPrompt({
    businessName: 'Kaki Bakery',
    gstRegistered: true,
    facts: assignRefs(facts),
    ordered: facts,
    history,
    now,
    meta,
    model: 'reply.simple',
  });

describe('prompt cache layout (ADR-007 decision 2, FEAT-004 AC-3)', () => {
  const first = turn(
    [FUDGE],
    [{ role: 'user', content: 'how much is the fudge cake?' }],
    new Date('2026-10-20T04:05:00Z'),
  );
  const second = turn(
    [EGGLESS],
    [
      { role: 'user', content: 'how much is the fudge cake?' },
      { role: 'assistant', content: 'The Chocolate fudge cake is S$55.00.' },
      { role: 'user', content: 'got eggless?' },
    ],
    new Date('2026-10-21T13:47:00Z'),
  );

  it('keeps the system prompt byte-identical across turns of a tenant', () => {
    expect(second.system).toBe(first.system);
    expect(first.system).toContain('Kaki Bakery');
    expect(first.system).not.toMatch(/\d{4}-\d{2}-\d{2}|^\[f:/m);
  });

  it('appends to the history and puts the facts and the time only in the tail', () => {
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(first.tail).toContain(`[f:${assignRefs([FUDGE]).refOf.get(FUDGE.id)}]`);
    expect(second.tail).toContain(`[f:${assignRefs([EGGLESS]).refOf.get(EGGLESS.id)}]`);
    expect(first.tail).toContain('Current time in Singapore: 2026-10-20 12:05 (Tuesday)');
    expect(second.tail).toContain('2026-10-21 21:47 (Wednesday)');
  });

  it('changes the system prompt only when the tenant block changes', () => {
    const other = buildVisitorPrompt({
      businessName: 'Second Tenant',
      gstRegistered: false,
      facts: assignRefs([]),
      ordered: [],
      history: [{ role: 'user', content: 'hi' }],
      now: new Date(),
      meta,
      model: 'reply.simple',
    });
    expect(other.system).not.toBe(first.system);
    expect(other.tail).toContain('(no matching facts)');
  });

  it('formats Singapore time across the date line', () => {
    expect(sgtNow(new Date('2026-12-31T16:30:00Z'))).toBe('2027-01-01 00:30 (Friday)');
  });
});
