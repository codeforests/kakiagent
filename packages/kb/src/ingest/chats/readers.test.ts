import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sgDay } from './messages.js';
import { readTelegram } from './telegram.js';
import { readWhatsApp } from './whatsapp.js';
import { chatTextFromZip } from './zip.js';

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe('readWhatsApp (FEAT-017 §5.3)', () => {
  it('reads Android d/m 24-hour lines, continuations, and drops system and media lines', () => {
    const r = ok(
      readWhatsApp(
        [
          '13/10/2026, 09:00 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
          '13/10/2026, 09:01 - Mdm Tan: Hi, do you deliver',
          'to Jurong?',
          '13/10/2026, 09:02 - Mdm Tan: <Media omitted>',
          '13/10/2026, 09:05 - Kaki Bakery: Yes, island-wide delivery.',
          '13/10/2026, 09:06 - Mdm Tan: This message was deleted',
        ].join('\n'),
      ),
    );
    expect(r.format).toBe('whatsapp');
    expect(r.messages.map((m) => [m.sender, m.text])).toEqual([
      ['Mdm Tan', 'Hi, do you deliver\nto Jurong?'],
      ['Kaki Bakery', 'Yes, island-wide delivery.'],
    ]);
    expect(r.messages[0]!.at.toISOString()).toBe('2026-10-13T01:01:00.000Z');
  });

  it('reads iOS bracketed 12-hour lines with direction marks', () => {
    const r = ok(
      readWhatsApp(
        [
          '[13/10/2026, 2:05:33 PM] Mdm Tan: ‎image omitted',
          '[13/10/2026, 2:05:40 PM] ‎Mdm Tan: Open on Sunday?',
          '[13/10/2026, 12:10:00 AM] Kaki Bakery: Yes 9am to 5pm',
        ].join('\n'),
      ),
    );
    expect(r.messages.map((m) => m.text)).toEqual(['Open on Sunday?', 'Yes 9am to 5pm']);
    expect(r.messages[0]!.at.toISOString()).toBe('2026-10-13T06:05:40.000Z');
    expect(r.messages[1]!.at.toISOString()).toBe('2026-10-12T16:10:00.000Z');
  });

  it('takes m/d when a second field over 12 shows it, and two-digit years', () => {
    const r = ok(
      readWhatsApp(['10/13/26, 9:00 am - A: Hello?', '10/14/26, 9:01 pm - B: Hi'].join('\n')),
    );
    expect(r.messages.map((m) => sgDay(m.at))).toEqual(['2026-10-13', '2026-10-14']);
    expect(r.messages[1]!.at.toISOString()).toBe('2026-10-14T13:01:00.000Z');
  });

  it('refuses prose as chat_format', () => {
    expect(readWhatsApp('Dear customers,\nWe are closed on Monday.\n')).toEqual({
      ok: false,
      failure: 'chat_format',
    });
  });
});

describe('readTelegram (FEAT-017 §5.3)', () => {
  it('reads a single-chat export with text parts and skips service messages', () => {
    const r = ok(
      readTelegram(
        JSON.stringify({
          name: 'Mdm Tan',
          type: 'personal_chat',
          messages: [
            { type: 'service', date: '2026-10-13T09:00:00', action: 'phone_call' },
            {
              type: 'message',
              date: '2026-10-13T09:01:00',
              from: 'Mdm Tan',
              from_id: 'user42',
              text: ['Is ', { type: 'bold', text: 'halal' }, ' cake available?'],
            },
            {
              type: 'message',
              date: '2026-10-13T09:02:00',
              from: 'Kaki Bakery',
              from_id: 'user7',
              text: [{ type: 'mention_name', text: 'Ah Kow', user_id: 9 }, ' yes'],
            },
          ],
        }),
      ),
    );
    expect(r.format).toBe('telegram');
    expect(r.businessIds).toEqual([]);
    expect(r.messages.map((m) => [m.sender, m.senderId, m.text])).toEqual([
      ['Mdm Tan', 'user42', 'Is halal cake available?'],
      ['Kaki Bakery', 'user7', 'Ah Kow yes'],
    ]);
    expect(r.messages[1]!.mentions).toEqual(['Ah Kow']);
    expect(r.messages[0]!.at.toISOString()).toBe('2026-10-13T01:01:00.000Z');
  });

  it('reads a full export: each chat a conversation, the account as the business, channels skipped', () => {
    const msg = (from: string, id: string, text: string) => ({
      type: 'message',
      date: '2026-10-13T09:00:00',
      date_unixtime: '1791853200',
      from,
      from_id: id,
      text,
    });
    const r = ok(
      readTelegram(
        JSON.stringify({
          personal_information: { user_id: 7, first_name: 'Kaki', phone_number: '+65 6123 4567' },
          chats: {
            list: [
              { type: 'saved_messages', messages: [msg('Kaki', 'user7', 'note')] },
              {
                type: 'personal_chat',
                messages: [msg('A', 'user1', 'Hi?'), msg('Kaki', 'user7', 'Hello')],
              },
              { type: 'public_channel', messages: [msg('News', 'channel1', 'Sale')] },
              { type: 'personal_chat', messages: [msg('B', 'user2', 'Price?')] },
            ],
          },
        }),
      ),
    );
    expect(r.businessIds).toEqual(['user7']);
    expect(r.conversations).toBe(2);
    expect(r.messages.map((m) => [m.conversation, m.text])).toEqual([
      [0, 'Hi?'],
      [0, 'Hello'],
      [1, 'Price?'],
    ]);
    expect(r.messages[0]!.at.toISOString()).toBe(new Date(1791853200 * 1000).toISOString());
  });

  it('refuses invalid JSON and other shapes as chat_format', () => {
    expect(readTelegram('{"a":1}').ok).toBe(false);
    expect(readTelegram('not json').ok).toBe(false);
    expect(readTelegram('{"messages":[]}').ok).toBe(false);
  });
});

describe('chatTextFromZip (FEAT-017 §5.3 step 2)', () => {
  it('takes _chat.txt beside media, and the only .txt otherwise', () => {
    const withMedia = zipSync({
      '_chat.txt': strToU8('﻿[13/10/2026, 2:05:33 PM] A: Hi'),
      '00000012-PHOTO-2026-10-13.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(chatTextFromZip(withMedia)).toEqual({
      ok: true,
      text: '[13/10/2026, 2:05:33 PM] A: Hi',
    });
    const one = zipSync({ 'WhatsApp Chat - A/chat.txt': strToU8('x') });
    expect(chatTextFromZip(one)).toEqual({ ok: true, text: 'x' });
  });

  it('refuses a zip with no text or several, and a broken zip', () => {
    expect(chatTextFromZip(zipSync({ 'a.jpg': new Uint8Array([1]) }))).toEqual({
      ok: false,
      failure: 'chat_format',
    });
    expect(chatTextFromZip(zipSync({ 'a.txt': strToU8('a'), 'b.txt': strToU8('b') })).ok).toBe(
      false,
    );
    expect(chatTextFromZip(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]))).toEqual({
      ok: false,
      failure: 'unreadable',
    });
  });
});
