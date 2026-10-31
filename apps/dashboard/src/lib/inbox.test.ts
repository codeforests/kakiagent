import type {
  ConversationList,
  ConversationSummary,
  ConversationThread,
  Message,
} from '@kaki/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  applySummary,
  dockText,
  eventText,
  flattenPages,
  matchesView,
  mergeMessages,
  rowTime,
  searchFromView,
  viewFromSearch,
} from './inbox.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const summary = (n: number, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: id(n),
  channel: 'widget',
  status: 'ai',
  lastMessageAt: `2026-10-31T0${n}:00:00.000Z`,
  lastMessage: `message ${n}`,
  flaggedAt: null,
  flagReasons: [],
  closeReason: null,
  closedAt: null,
  ...over,
});
const counts = { open: 0, escalated: 0, approval: 0, flagged: 0 };
const data = (
  pages: ConversationSummary[][],
  last: string | null = null,
): InfiniteData<ConversationList, unknown> => ({
  pages: pages.map((conversations, i) => ({
    conversations,
    counts,
    nextCursor: i === pages.length - 1 ? last : `c${i}`,
  })),
  pageParams: pages.map((_, i) => (i === 0 ? undefined : `c${i - 1}`)),
});
const ids = (d: InfiniteData<ConversationList, unknown> | undefined) =>
  flattenPages(d).map((c) => c.id);
const open = { view: 'open', channel: null } as const;

describe('view and URL', () => {
  it('leaves the default view as a bare /inbox', () => {
    expect(searchFromView(open)).toBe('');
    expect(viewFromSearch(new URLSearchParams(''))).toEqual(open);
  });
  it('round-trips a view and channel, and ignores unknown values', () => {
    const f = { view: 'flagged', channel: 'widget' } as const;
    expect(viewFromSearch(new URLSearchParams(searchFromView(f)))).toEqual(f);
    expect(viewFromSearch(new URLSearchParams('?view=nope&channel=sms'))).toEqual(open);
  });
});

describe('matchesView', () => {
  it('puts every state but closed in Open, and flagged rows in Flagged whatever their state', () => {
    expect(matchesView(summary(1), 'open', null)).toBe(true);
    expect(matchesView(summary(1, { status: 'closed' }), 'open', null)).toBe(false);
    const flaggedClosed = summary(1, { status: 'closed', flaggedAt: '2026-10-31T01:00:00.000Z' });
    expect(matchesView(flaggedClosed, 'flagged', null)).toBe(true);
    expect(matchesView(flaggedClosed, 'closed', null)).toBe(true);
    expect(matchesView(summary(1, { status: 'waiting_approval' }), 'approval', null)).toBe(true);
    expect(matchesView(summary(1), 'escalated', null)).toBe(false);
  });
});

describe('applySummary', () => {
  it('inserts a new conversation at the top', () => {
    const d = applySummary(data([[summary(3), summary(2)]]), summary(5), open);
    expect(ids(d)).toEqual([id(5), id(3), id(2)]);
  });
  it('moves an existing row to the top without duplicating it', () => {
    const d = data([[summary(3), summary(2)], [summary(1)]], 'more');
    const next = applySummary(d, summary(1, { lastMessageAt: '2026-10-31T09:00:00.000Z' }), open);
    expect(ids(next)).toEqual([id(1), id(3), id(2)]);
  });
  it('drops a row that leaves the view', () => {
    const d = applySummary(
      data([[summary(3), summary(2)]]),
      summary(3, { status: 'closed' }),
      open,
    );
    expect(ids(d)).toEqual([id(2)]);
  });
  it('keeps a closed flagged row in the Flagged view', () => {
    const flagged = summary(3, { flaggedAt: '2026-10-31T03:00:00.000Z' });
    const d = applySummary(
      data([[flagged]]),
      { ...flagged, status: 'closed' },
      {
        view: 'flagged',
        channel: null,
      },
    );
    expect(flattenPages(d)[0]?.status).toBe('closed');
  });
  it('leaves an older row for Load more while more pages exist', () => {
    const d = applySummary(data([[summary(5), summary(4)]], 'more'), summary(1), open);
    expect(ids(d)).toEqual([id(5), id(4)]);
    const done = applySummary(data([[summary(5), summary(4)]]), summary(1), open);
    expect(ids(done)).toEqual([id(5), id(4), id(1)]);
  });
  it('leaves an unloaded list alone', () => {
    expect(applySummary(undefined, summary(1), open)).toBeUndefined();
  });
});

const message = (seq: number, over: Partial<Message> = {}): Message => ({
  id: id(100 + seq),
  conversationId: id(1),
  seq,
  author: 'visitor',
  body: `m${seq}`,
  inReplyTo: null,
  disclosure: null,
  notice: null,
  noticeKind: null,
  language: null,
  createdAt: `2026-10-31T01:0${seq}:00.000Z`,
  ...over,
});
const thread = (messages: Message[]): ConversationThread => ({
  conversation: { ...summary(1), version: 1, createdAt: '2026-10-31T01:00:00.000Z' },
  messages: messages.map((m) => ({ ...m, factIds: [] })),
  hasEarlier: false,
  events: [],
  sidebar: {
    contact: {
      label: 'Website visitor',
      firstSeenAt: '2026-10-31T01:00:00.000Z',
      previousConversations: 0,
    },
    channel: 'widget',
    intents: [],
    lead: null,
    facts: [],
  },
});

describe('appendMessage', () => {
  it('appends in seq order and updates the preview', () => {
    const t = appendMessage(thread([message(1), message(3)]), message(2, { body: 'late' }));
    expect(t?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(t?.conversation.lastMessage).toBe('late');
  });
  it('ignores a message it already has, or one for another conversation', () => {
    const t = thread([message(1)]);
    expect(appendMessage(t, message(1))).toBe(t);
    expect(appendMessage(t, message(2, { conversationId: id(9) }))).toBe(t);
  });
  it('merges earlier pages with the latest by seq', () => {
    const a = thread([message(1), message(2)]).messages;
    const b = thread([message(2), message(3)]).messages;
    expect(mergeMessages(a, b).map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe('labels', () => {
  const at = '2026-10-31T06:32:00.000Z';
  it('names who or what caused a change, with a fallback name', () => {
    const actor = { type: 'user' as const, name: 'Mei Ling' };
    const close = {
      at,
      kind: 'state' as const,
      from: 'ai' as const,
      to: 'closed' as const,
      reason: 'staff' as const,
      actor,
    };
    expect(eventText(close)).toBe('Closed by Mei Ling');
    expect(eventText({ ...close, actor: { type: 'user', name: null } })).toBe(
      'Closed by A team member',
    );
    expect(eventText({ ...close, reason: 'inactive' })).toBe(
      'Closed after 30 minutes without messages',
    );
    expect(eventText({ ...close, from: 'closed', to: 'ai', reason: 'reopened' })).toBe(
      'Reopened by a new visitor message',
    );
    expect(eventText({ at, kind: 'flagged', from: null, to: null, reason: 'crisis', actor })).toBe(
      'Flagged: crisis message',
    );
  });
  it('tells staff when a closed chat cannot reopen', () => {
    expect(dockText({ status: 'closed', closeReason: 'visitor', closedAt: at })).toMatch(
      /can't be reopened/,
    );
    expect(dockText({ status: 'closed', closeReason: 'staff', closedAt: at })).toBe(
      'Closed by your team at 2:32 pm. A new message from the visitor reopens it.',
    );
  });
  it('shows today as a time, then Yesterday, then a date (Singapore time)', () => {
    const now = new Date('2026-10-31T06:00:00.000Z');
    expect(rowTime('2026-10-31T01:05:00.000Z', now)).toBe('9:05 am');
    expect(rowTime('2026-10-30T01:05:00.000Z', now)).toBe('Yesterday');
    expect(rowTime('2026-10-12T01:05:00.000Z', now)).toBe('12 Oct');
  });
});
