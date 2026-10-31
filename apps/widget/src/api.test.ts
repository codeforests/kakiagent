import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatEndedError, createApi, mergeMessages } from './api.js';
import { ALL_STRINGS, pickLocale, strings } from './strings.js';

const m = (id: string, seq: number) => ({
  id,
  seq,
  conversationId: '00000000-0000-4000-8000-000000000000',
  author: 'agent' as const,
  body: id,
  inReplyTo: null,
  disclosure: null,
  notice: null,
  noticeKind: null,
  authorName: null,
  language: null,
  createdAt: new Date().toISOString(),
});

describe('widget helpers', () => {
  it('merges messages by id in seq order', () => {
    const list = mergeMessages(mergeMessages([m('b', 2)], m('a', 1)), m('b', 2));
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('picks zh-Hans for Chinese and en otherwise', () => {
    expect(pickLocale('zh-SG')).toBe('zh-Hans');
    expect(pickLocale('en-SG')).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
    expect(strings('en').send).toBe('Send');
  });

  it('has the same non-empty keys in both locales (FEAT-033 AC-7)', () => {
    const keys = (l: keyof typeof ALL_STRINGS) => Object.keys(ALL_STRINGS[l]).sort();
    expect(keys('zh-Hans')).toEqual(keys('en'));
    for (const l of ['en', 'zh-Hans'] as const)
      for (const [k, v] of Object.entries(ALL_STRINGS[l])) {
        const text = typeof v === 'function' ? v('Bot') : v;
        expect(text.trim(), `${l}.${k}`).not.toBe('');
      }
  });
});

describe('widget api (FEAT-033)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('maps a 409 on send to ChatEndedError and other failures to a plain error', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'chat_ended' }));
    const api = createApi('https://api.test', 'tok');
    await expect(api.send('c1', 'hi', 'm1')).rejects.toBeInstanceOf(ChatEndedError);
    vi.stubGlobal('fetch', reply(500));
    const err = await api.send('c1', 'hi', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChatEndedError);
  });

  it('ends a conversation with the visitor token and no body', async () => {
    const fetch = reply(200, { status: 'closed' });
    vi.stubGlobal('fetch', fetch);
    await createApi('https://api.test', 'tok').endConversation('c1');
    expect(fetch).toHaveBeenCalledWith('https://api.test/widget/v1/conversations/c1/end', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      credentials: 'omit',
    });
    vi.stubGlobal('fetch', reply(404));
    await expect(createApi('https://api.test', 'tok').endConversation('c2')).rejects.toThrow(
      'end: 404',
    );
  });
});
