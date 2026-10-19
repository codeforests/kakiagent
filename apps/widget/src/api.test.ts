import { describe, expect, it } from 'vitest';
import { mergeMessages } from './api.js';
import { pickLocale, strings } from './strings.js';

const m = (id: string, seq: number) => ({
  id,
  seq,
  conversationId: '00000000-0000-4000-8000-000000000000',
  author: 'agent' as const,
  body: id,
  inReplyTo: null,
  disclosure: null,
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
});
