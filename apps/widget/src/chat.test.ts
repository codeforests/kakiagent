import type { Message } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  awaitingTurn,
  chatEnded,
  chromeLocale,
  emptyChat,
  greetingFor,
  langOf,
  menuItems,
  notLiveView,
  pausedNotice,
  pendingText,
  rowsOf,
  staffHandling,
  withMessage,
  withSegment,
} from './chat.js';

const CONV = '00000000-0000-4000-8000-000000000000';
const msg = (
  id: string,
  seq: number,
  author: Message['author'],
  inReplyTo: string | null = null,
) => ({
  id,
  seq,
  conversationId: CONV,
  author,
  body: `${id} body`,
  inReplyTo,
  disclosure: null,
  notice: null,
  noticeKind: null,
  authorName: null,
  language: null,
  createdAt: new Date().toISOString(),
});

describe('chat state (SCR-WGT-002 replying)', () => {
  const asked = withMessage(emptyChat, msg('v1', 1, 'visitor'));

  it('grows one reply per turn from its segments, in seq order, without repeats', () => {
    let c = withSegment(asked, { turnId: 'v1', seq: 1, text: 'Second.' });
    c = withSegment(c, { turnId: 'v1', seq: 0, text: 'First.' });
    c = withSegment(c, { turnId: 'v1', seq: 0, text: 'First again.' });
    expect(pendingText(c, 'v1')).toBe('First. Second.');
    expect(awaitingTurn(c)).toBe('v1');
  });

  it('replaces the segments with the stored reply and ignores late segments', () => {
    let c = withSegment(asked, { turnId: 'v1', seq: 0, text: 'First.' });
    c = withMessage(c, msg('a1', 2, 'agent', 'v1'));
    expect(pendingText(c, 'v1')).toBeNull();
    expect(c.messages.map((m) => m.id)).toEqual(['v1', 'a1']);
    c = withSegment(c, { turnId: 'v1', seq: 1, text: 'Late.' });
    expect(pendingText(c, 'v1')).toBeNull();
    expect(awaitingTurn(c)).toBeNull();
  });

  it('shows a stored reply that arrives first (a reconnect) directly', () => {
    const c = withMessage(asked, msg('a1', 2, 'agent', 'v1'));
    expect(c.segments).toEqual({});
    expect(awaitingTurn(c)).toBeNull();
  });

  it('waits on the latest visitor message only', () => {
    let c = withMessage(asked, msg('a1', 2, 'system', 'v1'));
    c = withMessage(c, msg('v2', 3, 'visitor'));
    expect(awaitingTurn(c)).toBe('v2');
    expect(awaitingTurn(emptyChat)).toBeNull();
  });
});

describe('after-hours notice and language of parts (FEAT-023; SCR-WGT-002)', () => {
  it('orders the disclosure, the notice, then the bubble', () => {
    const m = {
      ...msg('a1', 2, 'agent', 'v1'),
      disclosure: "You're chatting with an AI assistant for Kaki Bakery.",
      notice: "We're closed right now. The team will be back tomorrow at 9:00 am.",
      noticeKind: 'after_hours' as const,
    };
    expect(rowsOf(m).map((r) => [r.kind, r.key])).toEqual([
      ['disclosure', 'a1-disclosure'],
      ['notice', 'a1-notice'],
      ['message', 'a1'],
    ]);
    expect(rowsOf({ ...m, disclosure: null }).map((r) => r.kind)).toEqual(['notice', 'message']);
    expect(rowsOf(msg('a2', 3, 'agent', 'v2')).map((r) => r.kind)).toEqual(['message']);
  });

  it('marks text with Chinese characters as zh-Hans and leaves the rest to the panel', () => {
    expect(langOf('周六营业时间是上午9:00至下午5:00。')).toBe('zh-Hans');
    expect(langOf('Chocolate fudge cake（1 kg）的价格是S$55.00。')).toBe('zh-Hans');
    expect(langOf('The fudge cake is S$55.00 lah.')).toBeUndefined();
    expect(langOf('')).toBeUndefined();
  });
});

describe('greeting (FEAT-024; SCR-WGT-002 greeting)', () => {
  const greeting = { en: 'Hi! Ask me about our cakes.', zh: '你好！欢迎问我蛋糕的问题。' };

  it("shows the tenant's greeting in the panel locale", () => {
    expect(greetingFor(greeting, 'en')).toBe('Hi! Ask me about our cakes.');
    expect(greetingFor(greeting, 'zh-Hans')).toBe('你好！欢迎问我蛋糕的问题。');
    expect(langOf(greetingFor(greeting, 'zh-Hans'))).toBe('zh-Hans');
  });
});

describe('chat ended (FEAT-025; SCR-WGT-002 chat-ended)', () => {
  const ended = {
    ...msg('a9', 9, 'agent', 'v9'),
    body: "I'm ending this chat now. Our team can see this conversation.",
    notice: 'This chat has ended.',
    noticeKind: 'chat_ended' as const,
  };

  it('puts the chat-ended notice after the bubble, other notices before it', () => {
    expect(rowsOf(ended).map((r) => r.kind)).toEqual(['message', 'notice']);
    expect(rowsOf({ ...ended, disclosure: 'AI' }).map((r) => r.kind)).toEqual([
      'disclosure',
      'message',
      'notice',
    ]);
    expect(
      rowsOf({ ...ended, noticeKind: 'after_hours', notice: 'closed' }).map((r) => r.kind),
    ).toEqual(['notice', 'message']);
  });

  it('closes the composer once a message ends the chat', () => {
    const before = withMessage(withMessage(emptyChat, msg('v9', 8, 'visitor')), {
      ...ended,
      notice: null,
      noticeKind: null,
    });
    expect(chatEnded(before)).toBe(false);
    expect(chatEnded(withMessage(emptyChat, ended))).toBe(true);
  });
});

describe('chrome locale and header menu (FEAT-033; SCR-WGT-002)', () => {
  const lang = (m: ReturnType<typeof msg>, language: 'en' | 'zh' | null) => ({ ...m, language });

  it('follows the latest agent or system reply with a language, else the browser, else en', () => {
    expect(chromeLocale(emptyChat, 'zh-SG')).toBe('zh-Hans');
    expect(chromeLocale(emptyChat, undefined)).toBe('en');
    const zh = [msg('v1', 1, 'visitor'), lang(msg('a1', 2, 'agent', 'v1'), 'zh')].reduce(
      withMessage,
      emptyChat,
    );
    expect(chromeLocale(zh, 'en-SG')).toBe('zh-Hans');
    // Visitor and staff messages and null languages are ignored.
    const later = [
      lang(msg('s1', 3, 'staff'), null),
      lang(msg('v2', 4, 'visitor'), null),
      lang(msg('a2', 5, 'agent', 'v2'), null),
    ].reduce(withMessage, zh);
    expect(chromeLocale(later, 'en-SG')).toBe('zh-Hans');
    expect(chromeLocale(withMessage(later, lang(msg('x', 6, 'system'), 'en')), 'zh')).toBe('en');
    expect(chromeLocale(withMessage(emptyChat, msg('v', 1, 'visitor')), 'en')).toBe('en');
  });

  const off = { privacyNoticeUrl: null, controls: { talkToPerson: false } };
  const on = { privacyNoticeUrl: 'https://example.sg/privacy', controls: { talkToPerson: true } };
  const live = { conversationId: CONV, ended: false, preview: false };

  it('lists talk to a person only with the flag and not ended, privacy only with a URL', () => {
    expect(menuItems(on, live)).toEqual(['talkToPerson', 'privacy', 'end']);
    expect(menuItems(off, live)).toEqual(['end']);
    expect(menuItems(on, { ...live, ended: true })).toEqual(['privacy']);
  });

  it('offers End chat only with a live conversation outside the preview', () => {
    expect(menuItems(off, { ...live, conversationId: null })).toEqual([]);
    expect(menuItems(on, { ...live, conversationId: null })).toEqual(['talkToPerson', 'privacy']);
    expect(menuItems(off, { ...live, preview: true })).toEqual([]);
    expect(menuItems(on, { ...live, preview: true })).toEqual(['talkToPerson', 'privacy']);
  });
});

describe('not-live view (SCR-WGT-005, FEAT-034 AC-4)', () => {
  const offline = (contact: { email: string | null; phone: string | null }) => ({
    live: false as const,
    mode: 'message' as const,
    message: { en: "Our chat isn't open yet.", zh: '我们的聊天尚未开放。' },
    contact,
  });
  const both = offline({ email: 'hello@kakibakery.sg', phone: '+6561234567' });

  it('is null while live or hidden', () => {
    expect(notLiveView({ live: true }, 'en-SG')).toBeNull();
    expect(notLiveView({ ...both, mode: 'hidden' }, 'en-SG')).toBeNull();
  });

  it('picks the Chinese text for a zh browser and English otherwise', () => {
    expect(notLiveView(both, 'zh-CN')).toMatchObject({
      locale: 'zh-Hans',
      text: '我们的聊天尚未开放。',
    });
    expect(notLiveView(both, 'zh-Hant-TW')?.locale).toBe('zh-Hans');
    expect(notLiveView(both, 'en-GB')).toMatchObject({
      locale: 'en',
      text: "Our chat isn't open yet.",
    });
    expect(notLiveView(both, undefined)?.locale).toBe('en');
  });

  it('links each contact the business has, and only those', () => {
    expect(notLiveView(both, 'en')).toMatchObject({
      email: { label: 'hello@kakibakery.sg', href: 'mailto:hello@kakibakery.sg' },
      phone: { label: '+65 6123 4567', href: 'tel:+6561234567' },
    });
    expect(notLiveView(offline({ email: null, phone: '+6591234567' }), 'en')).toMatchObject({
      email: null,
      phone: { href: 'tel:+6591234567' },
    });
    expect(notLiveView(offline({ email: null, phone: null }), 'en')).toMatchObject({
      email: null,
      phone: null,
    });
  });

  it('leaves only the privacy notice in the menu', () => {
    const config = {
      privacyNoticeUrl: 'https://kakibakery.sg/privacy',
      controls: { talkToPerson: true },
    };
    expect(menuItems(config, { conversationId: null, ended: true, preview: false })).toEqual([
      'privacy',
    ]);
  });
});

describe('paused notice (SCR-WGT-005 paused, FEAT-057 AC-4, D7)', () => {
  const aiPaused = {
    message: { en: 'Our team will get back to you soon.', zh: '我们的团队会尽快回复您。' },
    contact: { email: 'hello@kakibakery.sg', phone: '+6561234567' },
  };
  const live = { live: true as const };

  it('is null while the AI runs', () => {
    expect(pausedNotice({ availability: live, aiPaused: null }, 'en-SG')).toBeNull();
  });

  it('shows the fallback in the browser language', () => {
    expect(pausedNotice({ availability: live, aiPaused }, 'en-SG')).toMatchObject({
      locale: 'en',
      text: 'Our team will get back to you soon.',
    });
    expect(pausedNotice({ availability: live, aiPaused }, 'zh-CN')).toMatchObject({
      locale: 'zh-Hans',
      text: '我们的团队会尽快回复您。',
    });
  });

  it('links each contact the business has, and only those', () => {
    expect(pausedNotice({ availability: live, aiPaused }, 'en')).toMatchObject({
      email: { href: 'mailto:hello@kakibakery.sg' },
      phone: { label: '+65 6123 4567', href: 'tel:+6561234567' },
    });
    const none = { ...aiPaused, contact: { email: null, phone: null } };
    expect(pausedNotice({ availability: live, aiPaused: none }, 'en')).toMatchObject({
      email: null,
      phone: null,
    });
  });

  it('gives way to the not-live view while the widget is offline', () => {
    const offline = {
      live: false as const,
      mode: 'message' as const,
      message: { en: "Our chat isn't open yet.", zh: '我们的聊天尚未开放。' },
      contact: { email: null, phone: null },
    };
    expect(pausedNotice({ availability: offline, aiPaused }, 'en')).toBeNull();
  });
});

describe('staff take-over (FEAT-043; SCR-WGT-002 human)', () => {
  const joined = {
    ...msg('s1', 2, 'system'),
    body: '',
    notice: 'Mei Ling joined the chat.',
    noticeKind: 'staff_joined' as const,
    authorName: 'Mei Ling',
  };
  const left = {
    ...msg('s3', 5, 'system'),
    body: '',
    notice: 'Mei Ling left the chat. The assistant will keep helping you.',
    noticeKind: 'staff_left' as const,
    authorName: 'Mei Ling',
  };
  const staff = { ...msg('m1', 3, 'staff'), body: 'Hi, Mei Ling here.', authorName: 'Mei Ling' };

  it('shows a staff notice as a notice row only, with no empty bubble', () => {
    expect(rowsOf(joined)).toEqual([
      { kind: 'notice', key: 's1-notice', text: 'Mei Ling joined the chat.' },
    ]);
  });

  it('names a staff bubble, falling back to the team-member label', () => {
    expect(rowsOf(staff)[0]).toMatchObject({ kind: 'message', name: 'Mei Ling' });
    expect(rowsOf({ ...staff, authorName: null }, '团队成员')[0]!.name).toBe('团队成员');
    expect(rowsOf({ ...staff, authorName: null })[0]!.name).toBe('A team member');
    expect(rowsOf(msg('a1', 1, 'agent', 'v1'))[0]!.name).toBeUndefined();
  });

  it('hides the assistant typing while staff handle, and shows it again after they leave', () => {
    let c = withMessage(withMessage(emptyChat, msg('v1', 1, 'visitor')), joined);
    c = withMessage(withMessage(c, staff), msg('v2', 4, 'visitor'));
    expect(staffHandling(c)).toBe(true);
    expect(awaitingTurn(c)).toBeNull();
    c = withMessage(withMessage(c, left), msg('v3', 6, 'visitor'));
    expect(staffHandling(c)).toBe(false);
    expect(awaitingTurn(c)).toBe('v3');
  });
});
