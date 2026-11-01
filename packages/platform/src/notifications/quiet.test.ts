import { describe, expect, it } from 'vitest';
import { fromClock, inQuietHours, quietEndsAt, sgMinutes, sgTimeOfDay, toClock } from './quiet.js';

/** A UTC instant for a Singapore wall-clock time on 2026-11-01 (UTC+8). */
const sg = (clock: string, day = 1) =>
  new Date(Date.UTC(2026, 10, day, 0, 0) + (fromClock(clock) - 8 * 60) * 60_000);

const NIGHT = { enabled: true, start: fromClock('22:00'), end: fromClock('08:00') };
const LUNCH = { enabled: true, start: fromClock('12:00'), end: fromClock('13:30') };

describe('quiet hours (Singapore time)', () => {
  it('reads Singapore wall-clock minutes from a UTC instant', () => {
    expect(sgMinutes(new Date('2026-11-01T14:30:00Z'))).toBe(fromClock('22:30'));
    expect(sgMinutes(new Date('2026-11-01T16:00:00Z'))).toBe(0);
  });

  it('a window crossing midnight: inside late and early, outside by day', () => {
    expect(inQuietHours(NIGHT, sg('23:15'))).toBe(true);
    expect(inQuietHours(NIGHT, sg('03:00'))).toBe(true);
    expect(inQuietHours(NIGHT, sg('12:00'))).toBe(false);
  });

  it('a window within the day', () => {
    expect(inQuietHours(LUNCH, sg('12:45'))).toBe(true);
    expect(inQuietHours(LUNCH, sg('11:59'))).toBe(false);
    expect(inQuietHours(LUNCH, sg('14:00'))).toBe(false);
  });

  it('start is inside, end is outside', () => {
    expect(inQuietHours(NIGHT, sg('22:00'))).toBe(true);
    expect(inQuietHours(NIGHT, sg('07:59'))).toBe(true);
    expect(inQuietHours(NIGHT, sg('08:00'))).toBe(false);
    expect(inQuietHours(LUNCH, sg('13:30'))).toBe(false);
  });

  it('turned off, nothing is quiet', () => {
    expect(inQuietHours({ ...NIGHT, enabled: false }, sg('23:00'))).toBe(false);
  });

  it('quietEndsAt is the next end, strictly after now', () => {
    expect(quietEndsAt(NIGHT, sg('23:00'))).toEqual(sg('08:00', 2));
    expect(quietEndsAt(NIGHT, sg('03:00'))).toEqual(sg('08:00'));
    expect(quietEndsAt(NIGHT, sg('08:00'))).toEqual(sg('08:00', 2));
  });

  it('clock conversions', () => {
    expect(toClock(1320)).toBe('22:00');
    expect(toClock(5)).toBe('00:05');
    expect(fromClock('08:00')).toBe(480);
    expect(() => fromClock('24:00')).toThrow();
    expect(sgTimeOfDay(sg('21:05'))).toBe('9:05 pm');
    expect(sgTimeOfDay(sg('00:10'))).toBe('12:10 am');
    expect(sgTimeOfDay(sg('12:00'))).toBe('12:00 pm');
  });
});
