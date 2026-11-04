import { describe, expect, it } from 'vitest';
import { ConversationSearchRequest, ConversationSearchResults, SearchMatch } from './index.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = '2026-11-03T09:00:00.000Z';
const summary = {
  id: ID,
  channel: 'widget',
  status: 'closed',
  lastMessageAt: AT,
  lastMessage: 'Thanks!',
  flaggedAt: null,
  flagReasons: [],
  closeReason: 'staff',
  closedAt: AT,
  owner: null,
  escalation: null,
} as const;
const match = {
  messageId: ID,
  author: 'visitor',
  at: AT,
  excerpt: '… my email is jane@example.com',
  ranges: [{ start: 14, end: 18 }],
} as const;

describe('conversation search contracts (FEAT-046 §3)', () => {
  it('round-trips a page of results', () => {
    const page = { results: [{ conversation: summary, match }], nextCursor: 'abc' };
    expect(ConversationSearchResults.parse(page)).toEqual(page);
    expect(ConversationSearchResults.parse({ results: [], nextCursor: null }).results).toEqual([]);
  });

  it('a match has at most 10 ranges and a known author', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ start: i, end: i + 1 }));
    expect(SearchMatch.safeParse({ ...match, ranges: many }).success).toBe(false);
    expect(SearchMatch.safeParse({ ...match, author: 'bot' }).success).toBe(false);
    expect(SearchMatch.safeParse({ ...match, ranges: [] }).success).toBe(true);
  });

  it('trims and collapses the query and defaults the limit', () => {
    expect(ConversationSearchRequest.parse({ q: '  jane \n doe ' })).toEqual({
      q: 'jane doe',
      limit: 25,
    });
    expect(ConversationSearchRequest.parse({ q: '美玲', cursor: 'c', limit: 50 })).toEqual({
      q: '美玲',
      cursor: 'c',
      limit: 50,
    });
  });

  it('refuses a 1-character or 101-character query, counting code points', () => {
    expect(ConversationSearchRequest.safeParse({ q: 'a' }).success).toBe(false);
    expect(ConversationSearchRequest.safeParse({ q: ' a  ' }).success).toBe(false);
    expect(ConversationSearchRequest.safeParse({ q: '😀' }).success).toBe(false);
    expect(ConversationSearchRequest.safeParse({ q: '😀😀' }).success).toBe(true);
    expect(ConversationSearchRequest.safeParse({ q: 'x'.repeat(100) }).success).toBe(true);
    expect(ConversationSearchRequest.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });

  it('refuses an extra key, such as a tenant ID, and a bad limit', () => {
    expect(ConversationSearchRequest.safeParse({ q: 'jane', tenantId: ID }).success).toBe(false);
    expect(ConversationSearchRequest.safeParse({ q: 'jane', limit: 51 }).success).toBe(false);
    expect(ConversationSearchRequest.safeParse({ q: 'jane', cursor: '' }).success).toBe(false);
  });
});
