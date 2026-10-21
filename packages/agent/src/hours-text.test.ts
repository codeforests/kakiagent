import { openStatus, WeeklyHours } from '@kaki/tenancy';
import { describe, expect, it } from 'vitest';
import { formatDay, formatNextOpen, formatTime, hoursLines, systemSlots } from './hours-text.js';

const at = (local: string) => new Date(`${local}+08:00`);
const HOURS = WeeklyHours.parse({
  mon: [{ open: '08:00', close: '19:00' }],
  tue: [{ open: '08:00', close: '19:00' }],
  wed: [{ open: '08:00', close: '19:00' }],
  thu: [{ open: '08:00', close: '19:00' }],
  fri: [{ open: '08:00', close: '19:00' }],
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [{ open: '09:00', close: '13:00' }],
});

describe('hours as visitors read them (FEAT-023 §5.2, NFR-10)', () => {
  it('formats times in English and Chinese', () => {
    expect(
      ['00:00', '08:00', '12:30', '13:00', '19:15', '24:00'].map((t) => formatTime(t, 'en')),
    ).toEqual(['midnight', '8:00 am', '12:30 pm', '1:00 pm', '7:15 pm', 'midnight']);
    expect(
      ['00:00', '08:00', '12:30', '13:00', '19:15', '24:00'].map((t) => formatTime(t, 'zh')),
    ).toEqual(['午夜12:00', '上午8:00', '中午12:30', '下午1:00', '晚上7:15', '午夜12:00']);
  });

  it('formats a day', () => {
    expect(formatDay(HOURS.sat, 'en')).toBe('9:00 am – 5:00 pm');
    expect(formatDay(HOURS.sat, 'zh')).toBe('上午9:00至下午5:00');
    const split = [
      { open: '08:00', close: '12:00' },
      { open: '14:00', close: '20:00' },
    ];
    expect(formatDay(split, 'en')).toBe('8:00 am – 12:00 pm, 2:00 pm – 8:00 pm');
    expect(formatDay(split, 'zh')).toBe('上午8:00至中午12:00、下午2:00至晚上8:00');
    expect(formatDay([], 'en')).toBe('closed');
    expect(formatDay([], 'zh')).toBe('休息');
  });

  it('formats the next opening relative to today', () => {
    const now = at('2026-10-21T23:00');
    expect(formatNextOpen(at('2026-10-21T23:30'), now, 'en')).toBe('today at 11:30 pm');
    expect(formatNextOpen(at('2026-10-22T08:00'), now, 'en')).toBe('tomorrow at 8:00 am');
    expect(formatNextOpen(at('2026-10-24T09:00'), now, 'en')).toBe('on Sat 24 Oct at 9:00 am');
    expect(formatNextOpen(at('2026-10-22T08:00'), now, 'zh')).toBe('明天上午8:00');
    expect(formatNextOpen(at('2026-10-24T09:00'), now, 'zh')).toBe('10月24日（周六）上午9:00');
    expect(formatNextOpen(at('2026-10-21T23:30'), now, 'zh')).toBe('今天晚上11:30');
  });

  it('builds the system slots for a closed turn, holiday included', () => {
    const now = at('2026-11-09T10:00'); // Monday in lieu of Deepavali
    const ctx = {
      hours: HOURS,
      openOnPublicHolidays: false,
      status: openStatus(HOURS, false, now),
      now,
    };
    const en = systemSlots(ctx, 'en');
    expect(en.get('hours.today')).toBe('closed (public holiday)');
    expect(en.get('hours.mon')).toBe('8:00 am – 7:00 pm');
    expect(en.get('hours.ph')).toBe('closed');
    expect(en.get('next_open')).toBe('tomorrow at 8:00 am');
    expect(systemSlots(ctx, 'zh').get('hours.today')).toBe('公共假期休息');
  });

  it('has no next_open slot while open, and no slots without hours', () => {
    const now = at('2026-10-21T11:00');
    const ctx = {
      hours: HOURS,
      openOnPublicHolidays: true,
      status: openStatus(HOURS, true, now),
      now,
    };
    const slots = systemSlots(ctx, 'en');
    expect(slots.has('next_open')).toBe(false);
    expect(slots.get('hours.ph')).toBe('usual hours');
    expect(systemSlots(null, 'en').size).toBe(0);
  });

  it('lists the week for the tenant block', () => {
    expect(hoursLines(HOURS, false)).toHaveLength(8);
    expect(hoursLines(HOURS, false)[6]).toBe('Hours sun: 9:00 am – 1:00 pm → [[s:hours.sun]]');
  });
});
