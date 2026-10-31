import { describe, expect, it } from 'vitest';
import {
  ConversationListQuery,
  ConversationSummary,
  HandBackBody,
  InboxMembers,
  MemberEvent,
  Message,
  OwnedError,
  StaffMessageBody,
  TakeOverBody,
  TakeoverResult,
  ThreadEvent,
} from './index.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = '2026-10-31T09:00:00.000Z';
const mei = { userId: ID, name: 'Mei Ling' };
const summary = {
  id: ID,
  channel: 'widget',
  status: 'human',
  lastMessageAt: AT,
  lastMessage: 'On it',
  flaggedAt: null,
  flagReasons: [],
  closeReason: null,
  closedAt: null,
  owner: mei,
} as const;
const notice = {
  id: ID,
  conversationId: ID,
  seq: 4,
  author: 'system',
  body: '',
  inReplyTo: null,
  disclosure: null,
  notice: 'Mei Ling joined the chat.',
  noticeKind: 'staff_joined',
  authorName: 'Mei Ling',
  language: 'en',
  createdAt: AT,
} as const;

describe('takeover contracts (FEAT-043 §3)', () => {
  it('take over, hand back and staff messages refuse extra keys', () => {
    expect(TakeOverBody.parse({ version: 2 })).toEqual({ version: 2 });
    expect(TakeOverBody.parse({ version: 2, from: ID })).toEqual({ version: 2, from: ID });
    for (const bad of [{ version: 1, userId: ID }, { version: -1 }, { version: 1, from: 'x' }])
      expect(() => TakeOverBody.parse(bad)).toThrow();
    expect(() => HandBackBody.parse({ version: 1, from: ID })).toThrow();
    expect(StaffMessageBody.parse({ body: '  Hi  ', clientMessageId: 'c-12345678' })).toEqual({
      body: 'Hi',
      clientMessageId: 'c-12345678',
    });
    for (const bad of [
      { body: '   ', clientMessageId: 'c-12345678' },
      { body: 'x'.repeat(4001), clientMessageId: 'c-12345678' },
      { body: 'Hi', clientMessageId: 'short' },
      { body: 'Hi', clientMessageId: 'c-12345678', author: 'agent' },
    ])
      expect(() => StaffMessageBody.parse(bad)).toThrow();
  });

  it('round-trips the result, the owned error, members and member events', () => {
    const result = { conversation: summary, notice };
    expect(TakeoverResult.parse(result)).toEqual(result);
    expect(Message.parse({ ...notice, noticeKind: 'staff_left' }).noticeKind).toBe('staff_left');
    expect(() => Message.parse({ ...notice, noticeKind: 'staff_typing' })).toThrow();
    const owned = { error: 'owned', message: 'Mei Ling has it.', owner: mei };
    expect(OwnedError.parse(owned)).toEqual(owned);
    expect(InboxMembers.parse({ members: [mei] })).toEqual({ members: [mei] });
    for (const type of ['handover_requested', 'taken_from_you'] as const) {
      const e = { type, conversationId: ID, by: mei };
      expect(MemberEvent.parse(e)).toEqual(e);
    }
    expect(() => MemberEvent.parse({ type: 'session_ended' })).toThrow();
    expect(ConversationSummary.parse({ ...summary, owner: null }).owner).toBeNull();
  });

  it('the list query takes me, none or a member ID as assignee', () => {
    for (const assignee of ['me', 'none', ID])
      expect(ConversationListQuery.parse({ assignee }).assignee).toBe(assignee);
    expect(() => ConversationListQuery.parse({ assignee: 'anyone' })).toThrow();
  });

  it('a hand-over request is an event with no state and a subject', () => {
    const e = {
      at: AT,
      kind: 'state',
      from: null,
      to: null,
      reason: 'handover_requested',
      actor: { type: 'user', name: 'Ken' },
      subject: { name: 'Mei Ling' },
    };
    expect(ThreadEvent.parse(e)).toEqual(e);
  });
});
