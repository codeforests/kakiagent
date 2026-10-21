/**
 * Singapore public holidays as gazetted by MOM, with the Monday off in lieu when a
 * holiday falls on a Sunday (FEAT-023 D3). 2026 from MOM's 2026 list; 2027 from its
 * 18 Jun 2026 release. Hari Raya dates are subject to moon sighting: a late change is
 * an edit here. Each June MOM announces the next year; add it and bump the cover year.
 * FEAT-009 adds the names (shown on the business profile) and the tenant's own
 * exceptions on top of this calendar (`holidays` table, FEAT-009 D4).
 */
const DAYS: Record<number, [day: string, name: string][]> = {
  2026: [
    ['2026-01-01', "New Year's Day"],
    ['2026-02-17', 'Chinese New Year'],
    ['2026-02-18', 'Chinese New Year (second day)'],
    ['2026-03-21', 'Hari Raya Puasa'], // Saturday: no day in lieu
    ['2026-04-03', 'Good Friday'],
    ['2026-05-01', 'Labour Day'],
    ['2026-05-27', 'Hari Raya Haji'],
    ['2026-05-31', 'Vesak Day'], // Sunday
    ['2026-06-01', 'Day off for Vesak Day'],
    ['2026-08-09', 'National Day'], // Sunday
    ['2026-08-10', 'Day off for National Day'],
    ['2026-11-08', 'Deepavali'], // Sunday
    ['2026-11-09', 'Day off for Deepavali'],
    ['2026-12-25', 'Christmas Day'],
  ],
  2027: [
    ['2027-01-01', "New Year's Day"],
    ['2027-02-06', 'Chinese New Year'], // Saturday
    ['2027-02-07', 'Chinese New Year (second day)'], // Sunday
    ['2027-02-08', 'Day off for Chinese New Year'],
    ['2027-03-10', 'Hari Raya Puasa'],
    ['2027-03-26', 'Good Friday'],
    ['2027-05-01', 'Labour Day'], // Saturday
    ['2027-05-17', 'Hari Raya Haji'],
    ['2027-05-20', 'Vesak Day'],
    ['2027-08-09', 'National Day'],
    ['2027-10-28', 'Deepavali'],
    ['2027-12-25', 'Christmas Day'], // Saturday
  ],
};

/** The last year the calendar covers. Later days are never treated as holidays. */
export const SG_HOLIDAYS_COVER_THROUGH = 2027;

export interface PublicHoliday {
  /** A Singapore calendar day, `YYYY-MM-DD`. */
  day: string;
  name: string;
}

/** Every covered holiday in date order. */
export const SG_PUBLIC_HOLIDAY_LIST: readonly PublicHoliday[] = Object.values(DAYS)
  .flat()
  .map(([day, name]) => ({ day, name }));

export const SG_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set(
  SG_PUBLIC_HOLIDAY_LIST.map((h) => h.day),
);

/** `day` is a Singapore calendar day, `YYYY-MM-DD`. */
export function isSgPublicHoliday(day: string): boolean {
  return SG_PUBLIC_HOLIDAYS.has(day);
}

/** The holidays from `from` to `to`, both `YYYY-MM-DD` and inclusive (FEAT-009 §5.1). */
export function sgHolidaysBetween(from: string, to: string): PublicHoliday[] {
  return SG_PUBLIC_HOLIDAY_LIST.filter((h) => h.day >= from && h.day <= to);
}
