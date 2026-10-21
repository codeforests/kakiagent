import {
  sgDay,
  sgInstant,
  sgWeekday,
  WEEKDAYS,
  type Interval,
  type OpenStatus,
  type Weekday,
  type WeeklyHours,
} from '@kaki/tenancy';
import type { ReplyLanguage } from './language.js';

/**
 * Opening hours as visitors read them (NFR-10, design.md §6 "2:30 pm"; FEAT-023 §5.2):
 * the values behind the `[[s:hours.*]]` and `[[s:next_open]]` system slots.
 */

const EN_DAY: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
const ZH_DAY: Record<Weekday, string> = {
  mon: '周一',
  tue: '周二',
  wed: '周三',
  thu: '周四',
  fri: '周五',
  sat: '周六',
  sun: '周日',
};
const EN_MONTH = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** `8:00 am`, `12:30 pm`, `midnight`; 上午8:00, 中午12:30, 下午3:00, 晚上7:00, 午夜12:00. */
export function formatTime(time: string, lang: ReplyLanguage): string {
  const h = Number(time.slice(0, 2));
  const mm = time.slice(3, 5);
  if (lang === 'en') {
    if ((h === 0 || h === 24) && mm === '00') return 'midnight';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mm} ${h < 12 || h === 24 ? 'am' : 'pm'}`;
  }
  if (h === 0 || h === 24) return `午夜12:${mm}`;
  if (h < 12) return `上午${h}:${mm}`;
  if (h === 12) return `中午12:${mm}`;
  return `${h < 18 ? '下午' : '晚上'}${h - 12}:${mm}`;
}

export function formatInterval(i: Interval, lang: ReplyLanguage): string {
  return lang === 'en'
    ? `${formatTime(i.open, lang)} – ${formatTime(i.close, lang)}`
    : `${formatTime(i.open, lang)}至${formatTime(i.close, lang)}`;
}

/** One day's hours; `closed` / 休息 when there are none. */
export function formatDay(intervals: Interval[], lang: ReplyLanguage): string {
  if (!intervals.length) return lang === 'en' ? 'closed' : '休息';
  return intervals.map((i) => formatInterval(i, lang)).join(lang === 'en' ? ', ' : '、');
}

/** `today at 9:00 am`, `tomorrow at 9:00 am`, `on Sat 24 Oct at 9:00 am`; 今天上午9:00, 10月24日（周六）上午9:00. */
export function formatNextOpen(next: Date, now: Date, lang: ReplyLanguage): string {
  const day = sgDay(next);
  const days = Math.round(
    (sgInstant(day, '00:00').getTime() - sgInstant(sgDay(now), '00:00').getTime()) / 86_400_000,
  );
  const shifted = new Date(next.getTime() + 8 * 3600_000);
  const time = formatTime(shifted.toISOString().slice(11, 16), lang);
  const wd = sgWeekday(next);
  const month = shifted.getUTCMonth();
  const date = shifted.getUTCDate();
  if (lang === 'en') {
    if (days === 0) return `today at ${time}`;
    if (days === 1) return `tomorrow at ${time}`;
    return `on ${EN_DAY[wd]} ${date} ${EN_MONTH[month]} at ${time}`;
  }
  if (days === 0) return `今天${time}`;
  if (days === 1) return `明天${time}`;
  return `${month + 1}月${date}日（${ZH_DAY[wd]}）${time}`;
}

export interface HoursContext {
  hours: WeeklyHours;
  openOnPublicHolidays: boolean;
  status: OpenStatus;
  now: Date;
}

/** The system slots for this turn: name → rendered value (ADR-025 decision 5). */
export function systemSlots(ctx: HoursContext | null, lang: ReplyLanguage): Map<string, string> {
  const slots = new Map<string, string>();
  if (!ctx) return slots;
  for (const d of WEEKDAYS) slots.set(`hours.${d}`, formatDay(ctx.hours[d], lang));
  slots.set(
    'hours.today',
    ctx.status.closedForHoliday
      ? lang === 'en'
        ? 'closed (public holiday)'
        : '公共假期休息'
      : formatDay(ctx.status.today, lang),
  );
  slots.set(
    'hours.ph',
    ctx.openOnPublicHolidays
      ? lang === 'en'
        ? 'usual hours'
        : '照常营业'
      : lang === 'en'
        ? 'closed'
        : '休息',
  );
  if (!ctx.status.open && ctx.status.nextOpen)
    slots.set('next_open', formatNextOpen(ctx.status.nextOpen, ctx.now, lang));
  return slots;
}

/** The tenant block's hours lines: profile only, so the cached `system` stays stable (FEAT-004 AC-3). */
export function hoursLines(hours: WeeklyHours, openOnPublicHolidays: boolean): string[] {
  return [
    ...WEEKDAYS.map((d) => `Hours ${d}: ${formatDay(hours[d], 'en')} → [[s:hours.${d}]]`),
    `Hours on public holidays: ${openOnPublicHolidays ? 'usual hours' : 'closed'} → [[s:hours.ph]]`,
  ];
}
