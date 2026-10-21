import { describe, expect, it } from 'vitest';
import { hoursOn, openStatus, sgDay, sgInstant, sgWeekday, WeeklyHours } from './hours.js';
import { isSgPublicHoliday, SG_HOLIDAYS_COVER_THROUGH } from './sg-holidays.js';

/** The bakery's seeded hours (FEAT-023 §5.7). */
const BAKERY = WeeklyHours.parse({
  mon: [{ open: '08:00', close: '19:00' }],
  tue: [{ open: '08:00', close: '19:00' }],
  wed: [{ open: '08:00', close: '19:00' }],
  thu: [{ open: '08:00', close: '19:00' }],
  fri: [{ open: '08:00', close: '19:00' }],
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [{ open: '09:00', close: '13:00' }],
});
/** SGT wall time → instant. */
const at = (local: string) => new Date(`${local}+08:00`);

describe('SGT helpers', () => {
  it('maps instants to Singapore days and weekdays across midnight', () => {
    expect(sgDay(new Date('2026-10-21T15:59:59Z'))).toBe('2026-10-21');
    expect(sgDay(new Date('2026-10-21T16:00:00Z'))).toBe('2026-10-22');
    expect(sgWeekday(at('2026-10-21T23:59'))).toBe('wed');
    expect(sgWeekday(at('2026-10-22T00:00'))).toBe('thu');
    expect(sgDay(new Date('2026-12-31T16:30:00Z'))).toBe('2027-01-01');
    expect(sgWeekday(at('2027-01-01T00:30'))).toBe('fri');
  });

  it('turns a Singapore day and time into an instant', () => {
    expect(sgInstant('2026-10-21', '09:00').toISOString()).toBe('2026-10-21T01:00:00.000Z');
    expect(sgInstant('2026-10-21', '24:00').toISOString()).toBe('2026-10-21T16:00:00.000Z');
  });
});

describe('WeeklyHours', () => {
  it('rejects malformed schedules', () => {
    const day = (d: unknown) => ({ ...BAKERY, mon: d });
    expect(WeeklyHours.safeParse(day([{ open: '9:00', close: '17:00' }])).success).toBe(false);
    expect(WeeklyHours.safeParse(day([{ open: '17:00', close: '09:00' }])).success).toBe(false);
    expect(
      WeeklyHours.safeParse(
        day([
          { open: '09:00', close: '13:00' },
          { open: '12:00', close: '18:00' },
        ]),
      ).success,
    ).toBe(false);
    expect(WeeklyHours.safeParse({ mon: [] }).success).toBe(false);
    expect(WeeklyHours.safeParse(day([{ open: '18:00', close: '24:00' }])).success).toBe(true);
  });
});

describe('openStatus (FEAT-023 AC-6)', () => {
  it('is open during an opening, since its start', () => {
    const s = openStatus(BAKERY, false, at('2026-10-21T11:00'));
    expect(s.open).toBe(true);
    expect(s.since).toEqual(at('2026-10-21T08:00'));
    expect(s.nextOpen).toBeNull();
    expect(s.today).toEqual([{ open: '08:00', close: '19:00' }]);
  });

  it('is closed overnight, reopening tomorrow', () => {
    const s = openStatus(BAKERY, false, at('2026-10-21T23:00'));
    expect(s).toMatchObject({ open: false, since: at('2026-10-21T19:00') });
    expect(s.nextOpen).toEqual(at('2026-10-22T08:00'));
  });

  it('is closed on Sunday afternoon, reopening on Monday', () => {
    const s = openStatus(BAKERY, false, at('2026-10-25T15:00'));
    expect(s.since).toEqual(at('2026-10-25T13:00'));
    expect(s.nextOpen).toEqual(at('2026-10-26T08:00'));
  });

  it('handles a split day', () => {
    const split = {
      ...BAKERY,
      wed: [
        { open: '08:00', close: '12:00' },
        { open: '14:00', close: '20:00' },
      ],
    };
    const lunch = openStatus(split, false, at('2026-10-21T13:00'));
    expect(lunch).toMatchObject({ open: false, since: at('2026-10-21T12:00') });
    expect(lunch.nextOpen).toEqual(at('2026-10-21T14:00'));
  });

  it('merges an opening to midnight with one from midnight', () => {
    const late = {
      ...BAKERY,
      fri: [{ open: '18:00', close: '24:00' }],
      sat: [
        { open: '00:00', close: '02:00' },
        { open: '18:00', close: '24:00' },
      ],
    };
    const s = openStatus(late, false, at('2026-10-24T01:00'));
    expect(s).toMatchObject({ open: true, since: at('2026-10-23T18:00') });
    const after = openStatus(late, false, at('2026-10-24T03:00'));
    expect(after.since).toEqual(at('2026-10-24T02:00'));
  });

  it('is closed on a public holiday and reopens on the next working day', () => {
    // Deepavali falls on Sunday 8 Nov 2026; Monday 9 Nov is the day in lieu.
    const s = openStatus(BAKERY, false, at('2026-11-08T10:00'));
    expect(s.open).toBe(false);
    expect(s.closedForHoliday).toBe(true);
    expect(s.today).toEqual([]);
    expect(s.since).toEqual(at('2026-11-07T17:00'));
    expect(s.nextOpen).toEqual(at('2026-11-10T08:00'));
  });

  it('keeps usual hours on a public holiday when the business opens on them', () => {
    const s = openStatus(BAKERY, true, at('2026-11-09T10:00'));
    expect(s).toMatchObject({ open: true, closedForHoliday: false });
  });

  it('crosses the year end', () => {
    const s = openStatus(BAKERY, false, at('2026-12-31T22:00'));
    // 1 Jan 2027 is a holiday (Friday); Saturday 2 Jan opens at 9:00.
    expect(s.nextOpen).toEqual(at('2027-01-02T09:00'));
  });

  it('reports no opening within the horizon', () => {
    const shut = WeeklyHours.parse({
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    });
    expect(openStatus(shut, false, at('2026-10-21T11:00'))).toMatchObject({
      open: false,
      since: null,
      nextOpen: null,
    });
  });

  it('applies the holiday rule per day', () => {
    expect(hoursOn(BAKERY, false, '2026-11-09')).toEqual([]);
    expect(hoursOn(BAKERY, false, '2026-11-10')).toEqual([{ open: '08:00', close: '19:00' }]);
  });
});

describe('SG public holidays', () => {
  it('covers 2026 and 2027 with the Monday in lieu', () => {
    expect(SG_HOLIDAYS_COVER_THROUGH).toBe(2027);
    for (const d of ['2026-06-01', '2026-08-10', '2026-11-09', '2027-02-08'])
      expect(isSgPublicHoliday(d)).toBe(true);
    expect(isSgPublicHoliday('2026-10-21')).toBe(false);
    expect(isSgPublicHoliday('2028-01-01')).toBe(false);
  });
});
