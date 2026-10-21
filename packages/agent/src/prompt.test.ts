import type { VisitorFact } from '@kaki/kb';
import { openStatus, WeeklyHours } from '@kaki/tenancy';
import { describe, expect, it } from 'vitest';
import { systemSlots } from './hours-text.js';
import { buildVisitorPrompt, sgtNow } from './prompt.js';
import { assignRefs } from './slots.js';
import { EGGLESS, FUDGE } from './testing/facts.js';

const meta = { tenantId: '11111111-1111-4111-8111-111111111111' };
const turn = (
  facts: VisitorFact[],
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

describe('language, register and hours in the prompt (FEAT-023 AC-1)', () => {
  const HOURS = WeeklyHours.parse({
    mon: [{ open: '08:00', close: '19:00' }],
    tue: [{ open: '08:00', close: '19:00' }],
    wed: [{ open: '08:00', close: '19:00' }],
    thu: [{ open: '08:00', close: '19:00' }],
    fri: [{ open: '08:00', close: '19:00' }],
    sat: [{ open: '09:00', close: '17:00' }],
    sun: [{ open: '09:00', close: '13:00' }],
  });
  const build = (
    now: Date,
    language: 'en' | 'zh',
    register: 'standard' | 'singlish' | 'formal',
    hours = HOURS,
  ) => {
    const ctx = { hours, openOnPublicHolidays: false, status: openStatus(hours, false, now), now };
    return buildVisitorPrompt({
      businessName: 'Kaki Bakery',
      gstRegistered: true,
      facts: assignRefs([FUDGE]),
      ordered: [FUDGE],
      history: [{ role: 'user', content: 'when are you open?' }],
      now,
      meta,
      model: 'reply.simple',
      language,
      register,
      hours: ctx,
      systemSlots: systemSlots(ctx, language),
    });
  };
  const open = build(new Date('2026-10-21T03:00:00Z'), 'en', 'singlish');
  const closed = build(new Date('2026-10-21T15:00:00Z'), 'zh', 'formal');

  it('names the reply language and register in the tail only', () => {
    expect(open.tail).toContain('Reply language: English');
    expect(open.tail).toContain('Visitor register: singlish');
    expect(closed.tail).toContain('Reply language: Chinese (Simplified)');
    expect(closed.tail).toContain('Visitor register: formal');
    expect(open.system).not.toMatch(/Reply language: |Visitor register: /);
  });

  it('keeps the system prompt byte-identical across languages, registers and times', () => {
    expect(closed.system).toBe(open.system);
    expect(open.system).toContain('Hours sat: 9:00 am – 5:00 pm → [[s:hours.sat]]');
    expect(open.system).toContain('Hours on public holidays: closed → [[s:hours.ph]]');
  });

  it('changes the system prompt when the hours change', () => {
    const other = build(new Date('2026-10-21T03:00:00Z'), 'en', 'singlish', {
      ...HOURS,
      sun: [],
    });
    expect(other.system).not.toBe(open.system);
  });

  it('says whether the business is open, with the next opening as a slot', () => {
    expect(open.tail).toContain('Open now.');
    expect(open.tail).toContain("Today's hours: 8:00 am – 7:00 pm → [[s:hours.today]]");
    expect(closed.tail).toContain('Closed now; the team is back 明天上午8:00 → [[s:next_open]]');
  });
});
