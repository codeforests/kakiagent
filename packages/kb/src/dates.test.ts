import { describe, expect, it } from 'vitest';
import { isSgDate, sgDateOf, sgDayAfter, sgDayLabel, sgDayStart, sgLastDayOf } from './dates.js';

describe('Singapore calendar days (FEAT-011 D3; AC-5)', () => {
  it('a day starts at 00:00 SGT, which is 16:00 UTC the day before', () => {
    expect(sgDayStart('2026-10-31').toISOString()).toBe('2026-10-30T16:00:00.000Z');
    expect(sgDayAfter('2026-10-31').toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(sgDayAfter('2026-12-31').toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });

  it('maps instants back to the SGT day across midnight', () => {
    expect(sgDateOf(new Date('2026-10-31T15:59:59.999Z'))).toBe('2026-10-31'); // 23:59:59 SGT
    expect(sgDateOf(new Date('2026-10-31T16:00:00.000Z'))).toBe('2026-11-01'); // 00:00 SGT
    expect(sgLastDayOf(sgDayAfter('2026-10-31'))).toBe('2026-10-31');
    expect(sgDateOf(sgDayStart('2027-01-01'))).toBe('2027-01-01');
  });

  it('accepts only real calendar days', () => {
    expect(isSgDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '31/10/2026', ''])
      expect(isSgDate(bad)).toBe(false);
    expect(() => sgDayStart('2026-02-30')).toThrow(RangeError);
  });

  it('labels days as design.md writes them', () => {
    expect(sgDayLabel('2026-10-31')).toBe('31 Oct 2026');
    expect(sgDayLabel('2026-09-05')).toBe('5 Sep 2026');
  });
});
