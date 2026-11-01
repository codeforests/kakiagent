/**
 * Quiet hours (LED-04, DSH-09; FEAT-052 §5.1, D5): Singapore time, which is UTC+8 with no DST,
 * so plain arithmetic is exact. Bounds are minutes after midnight; `[start, end)` wraps
 * midnight when `start > end`.
 */
export const TIME_ZONE = 'Asia/Singapore';
const OFFSET_MIN = 8 * 60;
const DAY_MIN = 24 * 60;
const MINUTE_MS = 60_000;

export interface QuietHours {
  enabled: boolean;
  /** Minutes after midnight, Singapore time. */
  start: number;
  end: number;
}

/** Minutes after midnight in Singapore at `now`. */
export function sgMinutes(now: Date): number {
  const m = Math.floor(now.getTime() / MINUTE_MS) + OFFSET_MIN;
  return ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

export function inQuietHours(q: QuietHours, now: Date): boolean {
  if (!q.enabled || q.start === q.end) return false;
  const m = sgMinutes(now);
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

/** The next instant quiet hours end, strictly after `now` (for the digest's wording). */
export function quietEndsAt(q: QuietHours, now: Date): Date {
  const minuteStart = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const ahead = (q.end - sgMinutes(now) + DAY_MIN) % DAY_MIN || DAY_MIN;
  return new Date(minuteStart + ahead * MINUTE_MS);
}

/** 1320 → "22:00". */
export function toClock(min: number): string {
  const h = Math.floor(min / 60);
  return `${String(h).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** "22:00" → 1320. Throws on anything that isn't HH:MM within a day. */
export function fromClock(clock: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!m) throw new Error(`not a clock time: ${clock}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "9:05 pm", Singapore time: the digest's per-alert time. */
export function sgTimeOfDay(at: Date): string {
  const m = sgMinutes(at);
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
