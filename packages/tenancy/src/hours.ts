import { z } from 'zod';
import { isSgPublicHoliday } from './sg-holidays.js';

/**
 * Opening hours (ONB-03, AGT-09; FEAT-023 §5.1): a weekly schedule in Singapore time.
 * SGT is a fixed UTC+8 with no daylight saving, so the maths is offset arithmetic.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const Interval = z
  .object({
    open: z.string().regex(TIME),
    close: z.union([z.string().regex(TIME), z.literal('24:00')]),
  })
  .refine((i) => minutes(i.open) < minutes(i.close), { message: 'open must be before close' });
export type Interval = z.infer<typeof Interval>;

const Day = z
  .array(Interval)
  .max(4)
  .refine((d) => d.every((i, k) => k === 0 || minutes(d[k - 1]!.close) <= minutes(i.open)), {
    message: 'intervals must be sorted and not overlap',
  });

export const WeeklyHours = z.object(
  Object.fromEntries(WEEKDAYS.map((d) => [d, Day])) as Record<Weekday, typeof Day>,
);
export type WeeklyHours = z.infer<typeof WeeklyHours>;

const SGT_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
/** How far `openStatus` looks back and ahead. */
export const HORIZON_DAYS = 14;

/** The Singapore calendar day of an instant, `YYYY-MM-DD`. */
export function sgDay(instant: Date): string {
  return new Date(instant.getTime() + SGT_MS).toISOString().slice(0, 10);
}

/** The Singapore weekday of an instant. */
export function sgWeekday(instant: Date): Weekday {
  // 1 Jan 1970 was a Thursday.
  const days = Math.floor((instant.getTime() + SGT_MS) / DAY_MS);
  return WEEKDAYS[(((days + 3) % 7) + 7) % 7]!;
}

/** The instant of `HH:MM` (or `24:00`) SGT on a Singapore day. */
export function sgInstant(day: string, time: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - SGT_MS + minutes(time) * 60_000);
}

/**
 * The tenant's exceptions to the SG calendar (FEAT-009 D4), day → kind: `open` = usual
 * hours on a public holiday, `closed` = closed all day.
 */
export type HolidayExceptions = Readonly<Record<string, 'open' | 'closed'>>;

const NO_EXCEPTIONS: HolidayExceptions = {};

/** Why today is closed although its weekday has hours. */
export type ClosedReason = 'public_holiday' | 'closure';

export interface OpenStatus {
  open: boolean;
  /** Open: when this opening started. Closed: when the last one ended (null: none in the horizon). */
  since: Date | null;
  /** Closed: the next opening (null: none in the horizon). Open: null. */
  nextOpen: Date | null;
  /** Today's intervals after the public-holiday rule. */
  today: Interval[];
  /** Today is a public holiday on which the business is closed. */
  closedForHoliday: boolean;
  /** Today's weekday has hours but the business is closed (null: not so). */
  closedReason: ClosedReason | null;
}

/** Why `day` is closed despite its weekday's hours, or null. */
function closedBy(
  openOnPublicHolidays: boolean,
  day: string,
  exceptions: HolidayExceptions,
): ClosedReason | null {
  const kind = exceptions[day];
  if (kind === 'closed') return isSgPublicHoliday(day) ? 'public_holiday' : 'closure';
  if (isSgPublicHoliday(day) && !openOnPublicHolidays && kind !== 'open') return 'public_holiday';
  return null;
}

/** One day's intervals after the holiday rule and the tenant's exceptions (FEAT-009 D4). */
export function hoursOn(
  hours: WeeklyHours,
  openOnPublicHolidays: boolean,
  day: string,
  exceptions: HolidayExceptions = NO_EXCEPTIONS,
): Interval[] {
  if (closedBy(openOnPublicHolidays, day, exceptions)) return [];
  return hours[sgWeekday(sgInstant(day, '12:00'))];
}

/** Whether the business is open at `now`, since when, and when it next opens (AC-6). */
export function openStatus(
  hours: WeeklyHours,
  openOnPublicHolidays: boolean,
  now: Date,
  exceptions: HolidayExceptions = NO_EXCEPTIONS,
): OpenStatus {
  const today = sgDay(now);
  const spans: [number, number][] = [];
  for (let d = -HORIZON_DAYS; d <= HORIZON_DAYS; d++) {
    const day = sgDay(new Date(now.getTime() + d * DAY_MS));
    for (const i of hoursOn(hours, openOnPublicHolidays, day, exceptions)) {
      const s = sgInstant(day, i.open).getTime();
      const e = sgInstant(day, i.close).getTime();
      const last = spans.at(-1);
      // An opening to midnight followed by one from midnight is one opening.
      if (last && last[1] >= s) last[1] = Math.max(last[1], e);
      else spans.push([s, e]);
    }
  }
  const t = now.getTime();
  const todayHours = hoursOn(hours, openOnPublicHolidays, today, exceptions);
  const closedReason =
    hours[sgWeekday(now)].length > 0 ? closedBy(openOnPublicHolidays, today, exceptions) : null;
  const closedForHoliday = closedReason === 'public_holiday';
  const current = spans.find(([s, e]) => s <= t && t < e);
  if (current)
    return {
      open: true,
      since: new Date(current[0]),
      nextOpen: null,
      today: todayHours,
      closedForHoliday,
      closedReason,
    };
  const before = spans.filter(([, e]) => e <= t).at(-1);
  const after = spans.find(([s]) => s > t);
  return {
    open: false,
    since: before ? new Date(before[1]) : null,
    nextOpen: after ? new Date(after[0]) : null,
    today: todayHours,
    closedForHoliday,
    closedReason,
  };
}
