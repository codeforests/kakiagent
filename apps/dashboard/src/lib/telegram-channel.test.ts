import { TelegramChannelErrorCode } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  alertMembersText,
  degradedCopy,
  ignoredLines,
  lastReceivedText,
  linkedText,
  linkStateText,
  linkView,
  needsReload,
  telegramErrorText,
  tokenError,
} from './telegram-channel.ts';

const TOKEN = '123456789:AAHfixtureTokenxxxxxxxxxxxxxxxxxxxx';
const err = (code: string, status = 422) => new ApiError(status, code, code);

describe('tokenError', () => {
  it('accepts a BotFather token, trimmed', () => {
    expect(tokenError(TOKEN)).toBeNull();
    expect(tokenError(`  ${TOKEN}\n`)).toBeNull();
  });
  it('asks for one when empty, and names the format otherwise', () => {
    expect(tokenError(' ')).toBe('Paste the token BotFather sent you.');
    expect(tokenError('123:abc')).toMatch(/^That doesn't look like a bot token/);
    expect(tokenError('Use this token to access the HTTP API')).toMatch(/like 123456789:AA…$/);
  });
});

describe('telegramErrorText', () => {
  it('has a field text for every input error code (NFR-19)', () => {
    expect(telegramErrorText(err('invalid_format'))).toMatch(/doesn't look like a bot token/);
    expect(telegramErrorText(err('token_rejected'))).toMatch(/^Telegram didn't accept this token/);
    expect(telegramErrorText(err('bot_in_use', 409))).toMatch(/another business on KakiAgent/);
    expect(telegramErrorText(err('different_bot'))).toMatch(/^This token is for a different bot/);
    expect(telegramErrorText(err('provider_unavailable', 502))).toBe(
      "We couldn't reach Telegram. Try again in a minute.",
    );
  });
  it('leaves the reload cases to the stale alert', () => {
    for (const code of ['stale', 'already_connected', 'not_connected']) {
      expect(telegramErrorText(err(code, 409))).toBeNull();
      expect(needsReload(err(code, 409))).toBe(true);
    }
    expect(needsReload(err('token_rejected'))).toBe(false);
  });
  it('covers every contract error code and network failures', () => {
    for (const code of TelegramChannelErrorCode.options)
      expect(typeof (telegramErrorText(err(code)) ?? 'reload')).toBe('string');
    expect(telegramErrorText(new TypeError('fetch failed'))).toMatch(/Check your connection/);
  });
});

describe('degradedCopy', () => {
  it('maps each health reason to its text and action', () => {
    expect(degradedCopy('credential_revoked')).toMatchObject({ action: 'replace' });
    expect(degradedCopy('credential_revoked').text).toMatch(/\/token in @BotFather/);
    expect(degradedCopy('credential_invalid')).toMatchObject({ action: 'check' });
    expect(degradedCopy('credential_invalid').text).toMatch(/connected to another service/);
    expect(degradedCopy('unreachable').text).toBe(
      "We can't reach Telegram right now. We'll keep trying.",
    );
    expect(degradedCopy(null).action).toBe('check');
  });
});

describe('lastReceivedText', () => {
  const now = new Date('2026-11-10T08:00:00Z');
  it('names the last message, or how to try it live, or that messages wait offline', () => {
    expect(
      lastReceivedText({ lastReceivedAt: '2026-11-10T07:55:00Z', connection: null }, now),
    ).toMatch(/^Last message .+\.$/);
    const conn = (state: 'live' | 'offline') => ({
      id: '00000000-0000-4000-8000-000000000001',
      state,
      health: 'ok' as const,
      healthReason: null,
      version: 1,
    });
    expect(lastReceivedText({ lastReceivedAt: null, connection: conn('live') }, now)).toBe(
      'No messages yet. Send your bot a message to try it.',
    );
    expect(lastReceivedText({ lastReceivedAt: null, connection: conn('offline') }, now)).toBe(
      'No messages yet. Messages wait in your inbox until you go live.',
    );
  });
});

describe('ignoredLines', () => {
  it('lists non-zero reasons in order, with plurals', () => {
    expect(
      ignoredLines([
        { reason: 'staff_chat', count: 1 },
        { reason: 'group', count: 3 },
        { reason: 'unsupported', count: 1 },
      ]),
    ).toEqual([
      '3 group messages',
      '1 sticker, photo or voice message',
      "1 message from team members' alert chats",
    ]);
    expect(ignoredLines([])).toEqual([]);
  });
});

describe('alert link', () => {
  const now = new Date('2026-11-10T08:00:00Z');
  const started = {
    url: 'https://t.me/kaki_bot?start=link-abc',
    expiresAt: '2026-11-10T08:15:00Z',
  };
  const link = (state: 'not_linked' | 'pending' | 'linked') => ({
    state,
    name: state === 'linked' ? 'Mei' : null,
    linkedAt: state === 'linked' ? '2026-11-09T02:00:00Z' : null,
  });
  it('shows pending with the URL while the start link is open', () => {
    expect(linkView(link('pending'), started, now)).toEqual({ kind: 'pending', url: started.url });
    expect(linkView(link('not_linked'), started, now)).toEqual({
      kind: 'pending',
      url: started.url,
    });
    expect(linkView(link('pending'), null, now)).toEqual({ kind: 'pending', url: null });
  });
  it('reads an expired start link as not linked, and linked wins', () => {
    const later = new Date('2026-11-10T08:15:01Z');
    expect(linkView(link('pending'), started, later)).toEqual({
      kind: 'not_linked',
      expired: true,
    });
    expect(linkView(link('not_linked'), null, now)).toEqual({ kind: 'not_linked', expired: false });
    expect(linkView(link('linked'), started, later)).toMatchObject({ kind: 'linked', name: 'Mei' });
  });
  it('words the linked line and the team count', () => {
    expect(linkedText('Mei', '2026-11-09T02:00:00Z')).toBe(
      'Alerts go to Mei on Telegram since 9 Nov 2026.',
    );
    expect(linkedText(null, null)).toBe('Alerts go to your Telegram.');
    expect(alertMembersText(1)).toBe('1 person on your team gets alerts here.');
    expect(alertMembersText(3)).toBe('3 people on your team get alerts here.');
  });
  it('linkStateText enables the Telegram switches only when linked', () => {
    expect(linkStateText(link('linked'), 'mei@kaki.sg')).toEqual({
      help: 'Alerts go to mei@kaki.sg and to Telegram (Mei).',
      enabled: true,
    });
    expect(linkStateText(link('pending'), 'mei@kaki.sg')).toEqual({
      help: 'Waiting for you to press Start in Telegram.',
      enabled: false,
    });
    expect(linkStateText(link('not_linked'), 'mei@kaki.sg')).toEqual({
      help: 'Link your Telegram to turn these on.',
      enabled: false,
    });
  });
});
