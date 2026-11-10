import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMAIL_CAPABILITIES } from '../email/capabilities.js';
import { shapeOutbound, type ShapeInput } from '../shape.js';
import {
  blockChange,
  classifyTelegram,
  normaliseUpdate,
  redactBotToken,
  TELEGRAM_CAPABILITIES,
  TelegramApiError,
  telegramApi,
  telegramIgnoreReason,
  telegramOf,
} from './index.js';

const ids = {
  tenantId: '00000000-0000-4000-8000-00000000000a',
  connectionId: '00000000-0000-4000-8000-00000000000c',
};
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/telegram/${name}.json`, import.meta.url), 'utf8'),
  );
const event = (name: string) => {
  const e = normaliseUpdate(fixture(name), ids);
  if (!e) throw new Error(`no event: ${name}`);
  return e;
};

describe('Telegram updates → canonical events (FEAT-037 §5.1)', () => {
  it('a private text message', () => {
    const e = event('private-text');
    expect(e).toMatchObject({
      kind: 'message',
      ...ids,
      externalUserId: '5550001',
      text: 'Do you deliver to Tampines?',
      localeHint: 'en',
      attachments: [],
    });
    expect(e.timestamp).toEqual(new Date(1763445900 * 1000));
    expect(telegramOf(e)).toMatchObject({
      chatId: 5550001,
      chatType: 'private',
      updateId: 1001,
      username: 'meitan',
      firstName: 'Mei',
      lastName: 'Tan',
      command: null,
      contentLabel: null,
    });
    expect(telegramIgnoreReason(e)).toBeNull();
  });

  it.each([
    ['caption', 'Is this cake available?', null, null],
    ['sticker', null, '[Sticker]', 'unsupported'],
    ['voice', null, '[Voice message]', 'unsupported'],
    ['group', 'hello bot', null, 'group'],
    ['supergroup', 'hello bot', null, 'group'],
  ])('%s', (name, text, label, reason) => {
    const e = event(name);
    expect(e.text).toBe(text);
    expect(telegramOf(e).contentLabel).toBe(label);
    expect(telegramIgnoreReason(e)).toBe(reason);
  });

  it('being added to a group is a group event; a private block and unblock are not ignored', () => {
    const added = event('added-to-group');
    expect(added.kind).toBe('postback');
    expect(telegramIgnoreReason(added)).toBe('group');
    const kicked = event('kicked');
    expect(telegramIgnoreReason(kicked)).toBeNull();
    expect(blockChange(kicked)).toBe('blocked');
    expect(blockChange(event('private-text'))).toBeNull();
  });

  it('/start and /start <code>', () => {
    expect(telegramOf(event('start'))).toMatchObject({ command: 'start', startPayload: null });
    expect(telegramOf(event('start-code'))).toMatchObject({
      command: 'start',
      startPayload: 'Zq3kVb8sTq1',
    });
    const other = normaliseUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 1, type: 'private' },
          text: '/Stop@kaki_bot',
        },
      },
      ids,
    );
    expect(telegramOf(other!)).toMatchObject({ command: 'stop', startPayload: null });
  });

  it('clips long text and drops unknown updates', () => {
    const long = normaliseUpdate(
      {
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 1, type: 'private' },
          text: 'a'.repeat(5000),
        },
      },
      ids,
    );
    expect(long!.text).toHaveLength(4000);
    expect(long!.text!.endsWith('[…]')).toBe(true);
    expect(normaliseUpdate({ update_id: 3, edited_message: {} }, ids)).toBeNull();
    expect(normaliseUpdate({ nope: true }, ids)).toBeNull();
  });
});

describe('Bot API errors and the token (FEAT-037 §5.1)', () => {
  it.each([
    [401, 'Unauthorized', { failed: 'auth', status: 401 }],
    [404, 'Not Found', { failed: 'auth', status: 404 }],
    [
      403,
      'Forbidden: bot was blocked by the user',
      { failed: 'permanent', status: 403, blocked: true },
    ],
    [400, 'Bad Request: chat not found', { failed: 'permanent', status: 400 }],
    [429, 'Too Many Requests', { failed: 'transient', status: 429, retryAfter: 7 }],
    [502, 'Bad Gateway', { failed: 'transient', status: 502 }],
  ] as const)('%i %s', (status, description, failure) => {
    expect(classifyTelegram(status, description, status === 429 ? 7 : undefined)).toEqual(failure);
  });

  it('sends plain text and maps a failure without the token in the error', async () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return String(url).endsWith('/sendMessage')
        ? Response.json({ ok: true, result: { message_id: 42 } })
        : Response.json(
            { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
            { status: 403 },
          );
    };
    const api = telegramApi(token, { base: 'http://fake.test/', fetch: fake });
    expect(await api.sendMessage(7, 'Hi')).toBe(42);
    expect(calls[0]).toEqual({
      url: `http://fake.test/bot${token}/sendMessage`,
      body: { chat_id: 7, text: 'Hi', link_preview_options: { is_disabled: true } },
    });
    const err = await api.leaveChat(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).failure).toEqual({
      failed: 'permanent',
      status: 403,
      blocked: true,
    });
    expect(String((err as Error).message)).not.toContain(token);
    const down = telegramApi(token, {
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}/getMe`);
      },
    });
    const net = await down.getMe().catch((e: unknown) => e);
    expect((net as TelegramApiError).failure).toEqual({ failed: 'transient' });
    expect((net as Error).message).not.toContain(token);
    expect(redactBotToken(`https://api.telegram.org/bot${token}/getMe`)).toBe(
      'https://api.telegram.org/bot[redacted]/getMe',
    );
  });
});

describe('the shaper footer capability (FEAT-037 D7)', () => {
  const msg = (over: Partial<ShapeInput>): ShapeInput => ({
    author: 'agent',
    body: 'Yes, we deliver.',
    notice: null,
    noticeKind: null,
    disclosure: null,
    card: null,
    ...over,
  });
  const base = { businessName: 'Kaki Bakery', privacyUrl: 'https://kakibakery.test/privacy' };
  const line = 'Kaki Bakery · Privacy notice: https://kakibakery.test/privacy';

  it('Telegram: the privacy line only with the disclosure', () => {
    const ctx = { ...base, capabilities: TELEGRAM_CAPABILITIES };
    expect(shapeOutbound(msg({ disclosure: "I'm Kaki Bakery's AI assistant." }), ctx)).toEqual({
      send: true,
      text: `I'm Kaki Bakery's AI assistant.\n\nYes, we deliver.\n\n${line}`,
    });
    expect(shapeOutbound(msg({}), ctx)).toEqual({ send: true, text: 'Yes, we deliver.' });
    expect(shapeOutbound(msg({ author: 'staff', body: 'Hi Mei' }), ctx)).toEqual({
      send: true,
      text: 'Hi Mei',
    });
    const long = shapeOutbound(msg({ body: 'x'.repeat(5000) }), ctx);
    expect(long.send && long.text.length).toBe(4096);
  });

  it('email: the footer on every message', () => {
    const ctx = { ...base, capabilities: EMAIL_CAPABILITIES };
    expect(shapeOutbound(msg({}), ctx)).toEqual({
      send: true,
      text: `Yes, we deliver.\n\n-- \n${line}`,
    });
  });
});
