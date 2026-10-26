import type { Message } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  awaitingTurn,
  chatEnded,
  emptyChat,
  greetingFor,
  langOf,
  pendingText,
  rowsOf,
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
