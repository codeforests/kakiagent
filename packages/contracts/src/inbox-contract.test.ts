import { describe, expect, it } from 'vitest';
import {
  CloseConversationBody,
  ConversationList,
  ConversationListQuery,
  ConversationThread,
  ThreadPageQuery,
  TurnQueueJob,
} from './index.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = '2026-10-31T09:00:00.000Z';
const summary = {
  id: ID,
  channel: 'widget',
  status: 'waiting_approval',
  lastMessageAt: AT,
  lastMessage: 'hi',
  flaggedAt: null,
  flagReasons: [],
  closeReason: null,
  closedAt: null,
  owner: null,
} as const;

describe('inbox contracts (FEAT-042 §3)', () => {
  it('defaults the list query to the open view, 25 a page', () => {
    expect(ConversationListQuery.parse({})).toEqual({ view: 'open', limit: 25 });
    expect(ConversationListQuery.parse({ view: 'closed', limit: '50', channel: 'widget' })).toEqual(
      { view: 'closed', limit: 50, channel: 'widget' },
    );
    for (const bad of [{ view: 'mine' }, { limit: '51' }, { limit: '0' }, { channel: 'email' }])
      expect(() => ConversationListQuery.parse(bad)).toThrow();
  });

  it('round-trips a list and a thread', () => {
    const list = {
      conversations: [summary],
      nextCursor: 'abc',
      counts: { open: 1, escalated: 0, approval: 1, flagged: 0 },
    };
    expect(ConversationList.parse(list)).toEqual(list);
    const thread = {
      conversation: { ...summary, version: 3, createdAt: AT },
      messages: [
        {
          id: ID,
          conversationId: ID,
          seq: 1,
          author: 'agent',
          body: 'S$55',
          inReplyTo: null,
          disclosure: null,
          notice: null,
          noticeKind: null,
          language: 'en',
          authorName: null,
          createdAt: AT,
          factIds: [ID],
          authorUserId: null,
        },
      ],
      hasEarlier: false,
      events: [
        {
          at: AT,
          kind: 'state',
          from: 'ai',
          to: 'closed',
          reason: 'staff',
          actor: { type: 'user', name: 'Mei' },
          subject: null,
        },
        {
          at: AT,
          kind: 'flagged',
          from: null,
          to: null,
          reason: 'crisis',
          actor: { type: 'agent', name: null },
          subject: null,
        },
      ],
      sidebar: {
        contact: { label: 'Website visitor', firstSeenAt: AT, previousConversations: 0 },
        channel: 'widget',
        intents: [{ signal: 'asked_questions', count: 1 }],
        lead: null,
        facts: [{ id: ID, type: 'product', label: 'Fudge cake', status: 'approved', uses: 1 }],
      },
    };
    expect(ConversationThread.parse(thread)).toEqual(thread);
  });

  it('close takes only a version; the thread page takes a positive seq', () => {
    expect(CloseConversationBody.parse({ version: 0 })).toEqual({ version: 0 });
    expect(() => CloseConversationBody.parse({ version: -1 })).toThrow();
    expect(() => CloseConversationBody.parse({ version: 1, status: 'ai' })).toThrow();
    expect(ThreadPageQuery.parse({ before: '12' })).toEqual({ before: 12 });
    expect(() => ThreadPageQuery.parse({ before: '0' })).toThrow();
  });

  it('the turns queue carries a turn or an auto-close job', () => {
    const turn = { tenantId: ID, conversationId: ID, messageId: ID };
    expect(TurnQueueJob.parse(turn)).toEqual(turn);
    const close = { kind: 'auto_close', tenantId: ID, conversationId: ID };
    expect(TurnQueueJob.parse(close)).toEqual(close);
    expect(() => TurnQueueJob.parse({ kind: 'auto_close', tenantId: ID })).toThrow();
  });
});
