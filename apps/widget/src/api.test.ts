import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatEndedError, MovedError, createApi, mergeMessages } from './api.js';
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

describe('lead routes (FEAT-049 §3)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const W = '00000000-0000-4000-8000-0000000000aa';

  it('posts the consent answer and returns the body', async () => {
    const fetch = reply(200, { consentId: null });
    vi.stubGlobal('fetch', fetch);
    const body = { purposeWordingId: W, agreed: false };
    const r = await createApi('https://api.test', 'tok').consent('c1', body);
    expect(r).toEqual({ ok: true, data: { consentId: null } });
    expect(fetch).toHaveBeenCalledWith('https://api.test/widget/v1/conversations/c1/consent', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  });

  it('hands back 422 field codes and 409 conflicts, and throws on anything else', async () => {
    const api = createApi('https://api.test', 'tok');
    const fields = { name: '', phone: '1234', email: '', need: '', budget: '', preferredTime: '' };
    const invalid = { error: 'invalid_fields', fields: { phone: 'invalid' }, needsContact: false };
    vi.stubGlobal('fetch', reply(422, invalid));
    expect(await api.submitLead('c1', { consentId: W, fields })).toEqual({
      ok: false,
      status: 422,
      body: invalid,
    });
    vi.stubGlobal('fetch', reply(409, { error: 'not_capturing' }));
    const contact = { purposeWordingId: W, agreed: true as const, fields };
    expect(await api.submitContact(contact)).toEqual({
      ok: false,
      status: 409,
      body: { error: 'not_capturing' },
    });
    vi.stubGlobal('fetch', reply(503));
    await expect(api.submitContact(contact)).rejects.toThrow('contact: 503');
  });
});

describe('handoff (FEAT-038 §3)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('returns the link, and the error codes and network failures as values', async () => {
    const api = createApi('https://api.test', 'tok');
    const url = 'https://t.me/kaki_bot?start=c-abc';
    const expiresAt = new Date().toISOString();
    vi.stubGlobal('fetch', reply(200, { channel: 'telegram', url, expiresAt }));
    expect(await api.handoff('c1', { channel: 'telegram' })).toEqual({
      ok: true,
      data: { channel: 'telegram', url, expiresAt },
    });
    vi.stubGlobal('fetch', reply(422, { error: 'invalid_email', message: 'x' }));
    expect(await api.handoff('c1', { channel: 'email', email: 'no' })).toEqual({
      ok: false,
      error: 'invalid_email',
    });
    vi.stubGlobal('fetch', reply(409, { error: 'moved', message: 'x', channel: 'email' }));
    expect(await api.handoff('c1', { channel: 'telegram' })).toEqual({
      ok: false,
      error: 'moved',
      channel: 'email',
    });
    vi.stubGlobal('fetch', reply(429, { error: 'rate_limited', message: 'x' }));
    expect(await api.handoff('c1', { channel: 'telegram' })).toMatchObject({
      error: 'rate_limited',
    });
    vi.stubGlobal('fetch', reply(502));
    expect(await api.handoff('c1', { channel: 'telegram' })).toEqual({
      ok: false,
      error: 'failed',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await api.handoff('c1', { channel: 'telegram' })).toEqual({
      ok: false,
      error: 'failed',
    });
  });

  it('maps a 409 moved on send to MovedError with the channel (AC-8)', async () => {
    const api = createApi('https://api.test', 'tok');
    vi.stubGlobal('fetch', reply(409, { error: 'moved', message: 'x', channel: 'telegram' }));
    const err = await api.send('c1', 'hi', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MovedError);
    expect((err as MovedError).channel).toBe('telegram');
  });
});
