import { describe, expect, it } from 'vitest';
import {
  NotificationPrefs,
  NotificationPrefsBody,
  QuietHours,
  RateLimitedError,
  TestAlertResult,
} from './index.js';

const quiet = { enabled: true, start: '22:00', end: '08:00' };

describe('notification contracts (FEAT-052 §3)', () => {
  it('prefs: the defaults shape parses', () => {
    expect(
      NotificationPrefs.parse({
        channels: ['email'],
        events: [
          { event: 'escalation', email: true },
          { event: 'approval_pending', email: true },
          { event: 'hot_lead', email: true },
        ],
        quietHours: quiet,
        timeZone: 'Asia/Singapore',
        sendTo: { email: 'owner@kaki-bakery.test', telegram: null },
      }).events,
    ).toHaveLength(3);
  });

  it('quiet hours: clock times only, may cross midnight, same start and end refused', () => {
    expect(QuietHours.safeParse(quiet).success).toBe(true);
    expect(QuietHours.safeParse({ ...quiet, start: '24:00' }).success).toBe(false);
    expect(QuietHours.safeParse({ ...quiet, start: '9:00' }).success).toBe(false);
    const same = QuietHours.safeParse({ enabled: true, start: '08:00', end: '08:00' });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]).toMatchObject({ path: ['end'], message: 'same_time' });
  });

  it('body: strict, unique known events, at most one per event', () => {
    const ok = { events: [{ event: 'hot_lead', email: false }], quietHours: quiet };
    expect(NotificationPrefsBody.safeParse(ok).success).toBe(true);
    // FEAT-051 acceptance: the page saves every event it lists, consent_withdrawn included.
    const all = ['escalation', 'approval_pending', 'hot_lead', 'consent_withdrawn'].map(
      (event) => ({ event, email: true }),
    );
    expect(NotificationPrefsBody.safeParse({ ...ok, events: all }).success).toBe(true);
    expect(NotificationPrefsBody.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      NotificationPrefsBody.safeParse({
        ...ok,
        events: [
          { event: 'hot_lead', email: false },
          { event: 'hot_lead', email: true },
        ],
      }).error?.issues[0]?.message,
    ).toBe('duplicate_event');
    expect(
      NotificationPrefsBody.safeParse({ ...ok, events: [{ event: 'test', email: true }] }).success,
    ).toBe(false);
  });

  it('test alert result and the rate-limit error', () => {
    expect(TestAlertResult.parse({ sentTo: 'a@b.test', telegram: false })).toEqual({
      sentTo: 'a@b.test',
      telegram: false,
    });
    expect(
      RateLimitedError.safeParse({ error: 'rate_limited', message: 'm', retryAfterSeconds: 42 })
        .success,
    ).toBe(true);
  });
});
