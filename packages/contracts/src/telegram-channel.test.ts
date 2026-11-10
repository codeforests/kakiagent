import { describe, expect, it } from 'vitest';
import {
  AlertEvent,
  ChannelQueueJob,
  NotificationPrefs,
  NotificationPrefsBody,
  TelegramAlertLink,
  TelegramChannelResponse,
  TelegramConnectBody,
  TelegramLinkStart,
  TelegramToken,
  TestAlertResult,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

describe('Telegram channel contracts (FEAT-037 §3)', () => {
  it('TelegramToken takes a BotFather-shaped token and refuses others', () => {
    expect(TelegramToken.safeParse(TOKEN).success).toBe(true);
    expect(TelegramToken.parse(`  ${TOKEN} `)).toBe(TOKEN);
    for (const bad of ['abc', '123:short', `${TOKEN}!`, 'abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'])
      expect(TelegramToken.safeParse(bad).success).toBe(false);
    expect(TelegramConnectBody.safeParse({ token: 'abc' }).success).toBe(false);
  });

  it('round-trips the channel response, connected and not', () => {
    const connected = {
      connected: true,
      connection: {
        id: ID,
        state: 'offline',
        health: 'degraded',
        healthReason: 'credential_revoked',
        version: 2,
      },
      bot: { id: '123456789', username: 'kaki_bot', name: 'Kaki', link: 'https://t.me/kaki_bot' },
      lastReceivedAt: AT,
      ignored: [{ reason: 'group', count: 2 }],
      alertMembers: 1,
      settingsVersion: 1,
    };
    expect(TelegramChannelResponse.parse(connected)).toEqual(connected);
    const none = {
      connected: false,
      connection: null,
      bot: null,
      lastReceivedAt: null,
      ignored: [],
      alertMembers: 0,
      settingsVersion: 0,
    };
    expect(TelegramChannelResponse.parse(none)).toEqual(none);
    expect(
      TelegramChannelResponse.safeParse({ ...none, ignored: [{ reason: 'spam', count: 1 }] })
        .success,
    ).toBe(false);
  });

  it('alert link, link start and the prefs with Telegram', () => {
    const link = { state: 'pending', name: null, linkedAt: null };
    expect(TelegramAlertLink.parse(link)).toEqual(link);
    expect(
      TelegramLinkStart.parse({ url: 'https://t.me/kaki_bot?start=abc', expiresAt: AT }).url,
    ).toContain('start=');
    const prefs = {
      channels: ['email', 'telegram'],
      events: [{ event: 'channel_degraded', email: true, telegram: false }],
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
      timeZone: 'Asia/Singapore',
      sendTo: { email: 'a@b.test', telegram: link },
    };
    expect(NotificationPrefs.parse(prefs)).toEqual(prefs);
    expect(
      NotificationPrefs.parse({ ...prefs, sendTo: { email: 'a@b.test', telegram: null } }),
    ).toBeTruthy();
    expect(TestAlertResult.parse({ sentTo: 'a@b.test', telegram: true }).telegram).toBe(true);
  });

  it('NotificationPrefsBody takes five events, with or without the Telegram switch', () => {
    expect(AlertEvent.options).toHaveLength(5);
    const events = AlertEvent.options.map((event, i) =>
      i % 2 ? { event, email: true } : { event, email: false, telegram: true },
    );
    const quietHours = { enabled: false, start: '22:00', end: '08:00' };
    expect(NotificationPrefsBody.safeParse({ events, quietHours }).success).toBe(true);
    expect(
      NotificationPrefsBody.safeParse({ events: [...events, events[0]], quietHours }).success,
    ).toBe(false);
  });

  it('channel-send carries message jobs and service jobs', () => {
    expect(ChannelQueueJob.parse({ tenantId: ID, messageId: ID })).toEqual({
      tenantId: ID,
      messageId: ID,
    });
    const service = {
      type: 'service',
      tenantId: ID,
      connectionId: ID,
      chatId: -100123,
      text: 'I only answer private messages.',
      leave: true,
      queuedAt: AT,
    };
    expect(ChannelQueueJob.parse(service)).toEqual(service);
  });
});
