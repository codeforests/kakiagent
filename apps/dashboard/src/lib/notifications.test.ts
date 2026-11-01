import type { NotificationPrefs } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  applyChange,
  bodyOf,
  EVENT_TEXT,
  overnight,
  quietError,
  quietHelp,
  quietServerError,
  quietSummary,
  testErrorText,
  undoOf,
} from './notifications.ts';

const prefs: NotificationPrefs = {
  channels: ['email'],
  events: [
    { event: 'escalation', email: true },
    { event: 'approval_pending', email: true },
    { event: 'hot_lead', email: true },
  ],
  quietHours: { enabled: true, start: '22:00', end: '08:00' },
  timeZone: 'Asia/Singapore',
  sendTo: { email: 'owner@kaki-bakery.test' },
};

describe('EVENT_TEXT', () => {
  it('words every event as in ui-design, without "notification event", "channel" or "mute"', () => {
    expect(EVENT_TEXT.escalation.label).toBe('A customer asks for a person');
    expect(EVENT_TEXT.approval_pending.label).toBe('A reply needs approval');
    expect(EVENT_TEXT.hot_lead.label).toBe('New hot lead');
    for (const t of Object.values(EVENT_TEXT))
      expect(`${t.label} ${t.help}`).not.toMatch(/notification event|channel|mute/i);
  });
});

describe('quiet hours text', () => {
  it('summarises the window in Singapore time', () => {
    expect(quietSummary({ start: '22:00', end: '08:00' })).toBe('22:00 to 08:00, Singapore time');
  });
  it('starts the help with "Overnight, " only when the window crosses midnight', () => {
    expect(overnight({ start: '22:00', end: '08:00' })).toBe(true);
    expect(overnight({ start: '12:00', end: '14:00' })).toBe(false);
    expect(quietHelp({ enabled: true, start: '22:00', end: '08:00' })).toMatch(
      /^Overnight, 22:00 to 08:00\. Singapore time\. Alerts that arrive/,
    );
    expect(quietHelp({ enabled: true, start: '12:00', end: '14:00' })).toMatch(
      /^Singapore time\. .*Urgent alerts.*still come straight away\.$/,
    );
  });
  it('says every alert comes at once when quiet hours are off', () => {
    expect(quietHelp({ enabled: false, start: '22:00', end: '08:00' })).toBe(
      'Every alert is emailed as it happens.',
    );
  });
});

describe('quietError and quietServerError', () => {
  it('needs both times and refuses the same start and end on "To"', () => {
    expect(quietError({ start: '', end: '08:00' })).toEqual({
      field: 'start',
      text: 'Enter a time.',
    });
    expect(quietError({ start: '22:00', end: '' })).toEqual({
      field: 'end',
      text: 'Enter a time.',
    });
    expect(quietError({ start: '09:00', end: '09:00' })).toEqual({
      field: 'end',
      text: 'Pick a different end time.',
    });
    expect(quietError({ start: '23:30', end: '06:15' })).toBeNull();
  });
  it('maps the 422 field codes to the same field errors and leaves other failures to the card', () => {
    const e422 = (fields: Record<string, string>) =>
      new ApiError(422, 'invalid_preferences', 'x', { error: 'invalid_preferences', fields });
    expect(quietServerError(e422({ 'quietHours.end': 'same_time' }))).toEqual({
      field: 'end',
      text: 'Pick a different end time.',
    });
    expect(quietServerError(e422({ 'quietHours.start': 'invalid' }))?.field).toBe('start');
    expect(quietServerError(e422({ events: 'duplicate_event' }))).toBeNull();
    expect(quietServerError(new ApiError(500, 'error', 'x'))).toBeNull();
    expect(quietServerError(new TypeError('offline'))).toBeNull();
  });
});

describe('testErrorText', () => {
  it('names the wait on a 429 and a generic retry otherwise', () => {
    const limited = new ApiError(429, 'rate_limited', 'x', { retryAfterSeconds: 42 });
    expect(testErrorText(limited)).toEqual({
      tone: 'warning',
      text: 'You just sent one. Try again in 42 seconds.',
    });
    expect(testErrorText(new ApiError(429, 'rate_limited', 'x')).text).toMatch(/in 60 seconds/);
    expect(testErrorText(new ApiError(500, 'error', 'x'))).toEqual({
      tone: 'danger',
      text: "We couldn't send a test alert. Try again.",
    });
  });
});

describe('applyChange, undoOf and bodyOf', () => {
  it('turns one event off and undoes only that change', () => {
    const change = { event: 'hot_lead' as const, email: false };
    const undo = undoOf(prefs, change);
    const off = applyChange(prefs, change);
    expect(off.events.find((e) => e.event === 'hot_lead')?.email).toBe(false);
    expect(off.events.find((e) => e.event === 'escalation')?.email).toBe(true);
    // Another switch saved meanwhile keeps its position when this one rolls back.
    const both = applyChange(off, { event: 'escalation', email: false });
    const rolled = applyChange(both, undo);
    expect(rolled.events.map((e) => e.email)).toEqual([false, true, true]);
  });
  it('replaces the quiet hours and sends the whole page as the PUT body', () => {
    const quietHours = { enabled: false, start: '22:00', end: '08:00' };
    expect(undoOf(prefs, { quietHours })).toEqual({ quietHours: prefs.quietHours });
    const next = applyChange(prefs, { quietHours });
    expect(bodyOf(next)).toEqual({ events: prefs.events, quietHours });
    expect(Object.keys(bodyOf(next))).toEqual(['events', 'quietHours']);
  });
});
