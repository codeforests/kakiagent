import { readFileSync } from 'node:fs';
import { chatTextFromZip, groupExchanges, readTelegram, readWhatsApp, sniffType } from '@kaki/kb';
import { describe, expect, it } from 'vitest';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/files/${name}`, import.meta.url)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const opts = { businessNames: ['Kaki Bakery'], businessIds: [], partLimit: 200 };

// The committed chat fixtures (FEAT-017 §5.8, T7) read as the kb tests expect.
describe('chat-export fixtures', () => {
  it('whatsapp-android.txt: 8 exchanges with the business, redacted', () => {
    const bytes = fixture('whatsapp-android.txt');
    expect(sniffType(bytes, 'x.txt', 'chat')).toEqual({ ok: true, type: 'txt' });
    const read = readWhatsApp(text(bytes));
    if (!read.ok) throw new Error('not read');
    const g = groupExchanges(read.messages, { ...opts, businessIds: read.businessIds })!;
    expect(g.exchanges).toBe(8);
    expect(g.parts.map((p) => p.content).join('\n')).not.toMatch(/Mei Ling|9123|S1234567D/);
  });

  it('whatsapp-ios.zip: the chat beside a photo', () => {
    const bytes = fixture('whatsapp-ios.zip');
    expect(sniffType(bytes, 'x.zip', 'chat')).toEqual({ ok: true, type: 'zip' });
    const z = chatTextFromZip(bytes);
    if (!z.ok) throw new Error('no chat');
    const read = readWhatsApp(z.text);
    expect(read.ok && read.messages.map((m) => m.text)).toEqual([
      'Got eggless cake?',
      'Yes, our eggless chocolate cake.',
    ]);
  });

  it('telegram-chat.json and telegram-full.json', () => {
    for (const name of ['telegram-chat.json', 'telegram-full.json']) {
      const bytes = fixture(name);
      expect(sniffType(bytes, 'x.json', 'chat')).toEqual({ ok: true, type: 'json' });
      const read = readTelegram(text(bytes));
      if (!read.ok) throw new Error(`${name} not read`);
      const g = groupExchanges(read.messages, { ...opts, businessIds: read.businessIds });
      expect(g?.exchanges, name).toBe(1);
    }
  });

  it('not-a-chat.txt and not-a-chat.json are refused as chat_format', () => {
    expect(readWhatsApp(text(fixture('not-a-chat.txt')))).toEqual({
      ok: false,
      failure: 'chat_format',
    });
    expect(readTelegram(text(fixture('not-a-chat.json')))).toEqual({
      ok: false,
      failure: 'chat_format',
    });
  });
});
