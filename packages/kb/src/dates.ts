/**
 * Singapore calendar days ↔ instants (FEAT-011 D3). Singapore has kept UTC+8 with no
 * daylight saving since 1982, so a fixed offset is exact for every date we store.
 */
const SGT_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written `YYYY-MM-DD` (not `2026-02-30`). */
export function isSgDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function utcMidnight(day: string): number {
  if (!isSgDate(day)) throw new RangeError(`not a calendar day: ${day}`);
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d);
}

/** 00:00 SGT at the start of `day`. */
export const sgDayStart = (day: string) => new Date(utcMidnight(day) - SGT_OFFSET_MS);

/** 00:00 SGT on the day after `day`: the exclusive end of a validity that ends on `day`. */
export const sgDayAfter = (day: string) => new Date(utcMidnight(day) + DAY_MS - SGT_OFFSET_MS);

/** The SGT calendar day an instant falls on. */
export const sgDateOf = (t: Date) =>
  new Date(t.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);

/** The last day of a validity whose exclusive end is `end`. */
export const sgLastDayOf = (end: Date) => sgDateOf(new Date(end.getTime() - 1));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "31 Oct 2026" (design.md §6, NFR-10) for an SGT calendar day. Built by hand: ICU's
 * English short months write "Sept", which design.md doesn't use.
 */
export function sgDayLabel(day: string): string {
  if (!isSgDate(day)) throw new RangeError(`not a calendar day: ${day}`);
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}
