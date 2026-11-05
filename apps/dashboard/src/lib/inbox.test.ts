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
  dockMode,
  dockText,
  cardCaption,
  eventText,
  leadLines,
  LEAD_STATUS,
  escalationStrip,
  escalationText,
  keepAssigneeName,
  waitingFor,
  filterOfKey,
  flattenPages,
  listKey,
  matchesView,
  memberToastText,
  ownerText,
  takeoverErrorText,
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
  owner: null,
  escalation: null,
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
const open = { view: 'open', channel: null, assignee: null } as const;

describe('view and URL', () => {
  it('leaves the default view as a bare /inbox', () => {
    expect(searchFromView(open)).toBe('');
    expect(viewFromSearch(new URLSearchParams(''))).toEqual(open);
  });
  it('round-trips a view and channel, and ignores unknown values', () => {
    const f = { view: 'flagged', channel: 'widget', assignee: null } as const;
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
        assignee: null,
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
  authorName: null,
  language: null,
  createdAt: `2026-10-31T01:0${seq}:00.000Z`,
  ...over,
});
const thread = (messages: Message[]): ConversationThread => ({
  conversation: { ...summary(1), version: 1, createdAt: '2026-10-31T01:00:00.000Z' },
  messages: messages.map((m) => ({ ...m, factIds: [], authorUserId: null, card: null })),
  hasEarlier: false,
  events: [],
  sidebar: {
    contact: {
      contactId: null,
      name: null,
      email: null,
      phone: null,
      label: 'Website visitor',
      firstSeenAt: '2026-10-31T01:00:00.000Z',
      previousConversations: 0,
    },
    channel: 'widget',
    intents: [],
    lead: null,
    facts: [],
    approval: null,
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
      subject: null,
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
    expect(
      eventText({
        at,
        kind: 'flagged',
        from: null,
        to: null,
        reason: 'crisis',
        actor,
        subject: null,
      }),
    ).toBe('Flagged: crisis message');
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

describe('takeover (FEAT-043)', () => {
  const ME = id(900);
  const MEI = id(901);
  const me = { user: { id: ME, email: 'ken@x.test', displayName: 'Ken' } };
  const mine = summary(1, { status: 'human', owner: { userId: ME, name: 'Ken' } });
  const meis = summary(2, { status: 'human', owner: { userId: MEI, name: 'Mei Ling' } });

  it('picks the dock by state and owner', () => {
    expect(dockMode(summary(1), me)).toBe('ai');
    expect(dockMode(summary(1, { status: 'escalated' }), me)).toBe('ai');
    expect(dockMode(summary(1, { status: 'waiting_approval' }), me)).toBe('ai');
    expect(dockMode(mine, me)).toBe('mine');
    expect(dockMode(meis, me)).toBe('other');
    expect(dockMode(summary(1, { status: 'human' }), me)).toBe('other');
    expect(dockMode(summary(1, { status: 'closed' }), me)).toBe('closed');
  });

  it('round-trips the assignee in the URL and the list key, ignoring junk', () => {
    for (const assignee of ['me', 'none', MEI]) {
      const f = { view: 'open', channel: null, assignee } as const;
      expect(searchFromView(f)).toContain(`assignee=${assignee}`);
      expect(viewFromSearch(new URLSearchParams(searchFromView(f)))).toEqual(f);
      expect(filterOfKey(listKey(f))).toEqual(f);
    }
    expect(viewFromSearch(new URLSearchParams('?assignee=bob')).assignee).toBeNull();
    expect(filterOfKey(listKey(open))).toEqual(open);
  });

  it('filters by the current owner', () => {
    expect(matchesView(mine, 'open', null, 'me', ME)).toBe(true);
    expect(matchesView(meis, 'open', null, 'me', ME)).toBe(false);
    expect(matchesView(summary(3), 'open', null, 'none', ME)).toBe(true);
    expect(matchesView(mine, 'open', null, 'none', ME)).toBe(false);
    expect(matchesView(meis, 'open', null, MEI, ME)).toBe(true);
    expect(matchesView(summary(3), 'open', null, MEI, ME)).toBe(false);
    // Handed back: the row leaves "Mine" live.
    const d = applySummary(
      data([[mine]]),
      { ...mine, status: 'ai', owner: null },
      {
        ...open,
        assignee: 'me',
      },
      ME,
    );
    expect(ids(d)).toEqual([]);
  });

  it('names the owner, "You" for me', () => {
    expect(ownerText(mine.owner, ME)).toBe('You');
    expect(ownerText(meis.owner, ME)).toBe('Mei Ling');
    expect(ownerText(null, ME)).toBe('A team member');
  });

  it('explains a refused action', () => {
    expect(takeoverErrorText('owned', { owner: meis.owner })).toBe(
      'Mei Ling took this over just now.',
    );
    expect(takeoverErrorText('not_owner', { conversation: meis })).toBe(
      "Mei Ling has taken over this conversation. Your reply wasn't sent.",
    );
    expect(takeoverErrorText('state_changed', { conversation: { ...meis, owner: null } })).toBe(
      "This conversation changed while you were looking. It's now human.",
    );
    expect(takeoverErrorText('closed', {})).toBe('This conversation was closed.');
    expect(takeoverErrorText('not_owned', {})).toMatch(/back with the assistant/);
    expect(takeoverErrorText('boom', {})).toBeNull();
  });

  it('writes the takeover dividers, with fallbacks for missing names', () => {
    const at = '2026-10-31T06:05:00.000Z';
    const base = { at, kind: 'state' as const, from: 'ai' as const, to: 'human' as const };
    const actor = { type: 'user' as const, name: 'Ken' };
    expect(eventText({ ...base, reason: 'taken_over', actor, subject: null })).toBe(
      'Ken took over',
    );
    expect(
      eventText({ ...base, from: 'human', to: 'ai', reason: 'handed_back', actor, subject: null }),
    ).toBe('Ken handed back to the assistant');
    expect(
      eventText({
        ...base,
        from: 'human',
        reason: 'taken_from',
        actor,
        subject: { name: 'Mei Ling' },
      }),
    ).toBe('Ken took over from Mei Ling');
    expect(
      eventText({
        ...base,
        from: null,
        to: null,
        reason: 'handover_requested',
        actor: { type: 'user', name: null },
        subject: { name: null },
      }),
    ).toBe('A team member asked a team member to hand over');
  });

  it('words the toasts sent to the owner', () => {
    const by = { userId: ME, name: 'Ken' };
    expect(memberToastText({ type: 'handover_requested', conversationId: id(1), by })).toEqual({
      text: 'Ken asks you to hand over a conversation.',
      action: 'Open conversation',
    });
    expect(
      memberToastText({ type: 'taken_from_you', conversationId: id(1), by: { ...by, name: '' } })
        .text,
    ).toBe('A team member took over a conversation you were handling.');
  });

  it('gives a live staff message no author ID until the thread refetches', () => {
    const t = appendMessage(
      thread([message(1)]),
      message(2, { author: 'staff', authorName: 'Ken' }),
    );
    expect(t?.messages.at(-1)?.authorUserId).toBeNull();
  });
});

describe('escalations (FEAT-044 AC-7)', () => {
  const ME = id(90);
  const MEI = id(91);
  const now = new Date('2026-11-01T06:10:00.000Z');
  const esc = (over: Partial<NonNullable<ConversationSummary['escalation']>> = {}) => ({
    id: id(80),
    assignee: { userId: MEI, name: 'Mei Ling' },
    since: '2026-11-01T06:04:00.000Z',
    source: 'visitor_button' as const,
    urgent: true,
    afterHours: false,
    reminders: 0,
    ...over,
  });
  const escalated = summary(1, { status: 'escalated', escalation: esc() });

  it('formats the wait: just now, minutes, hours, then the date', () => {
    expect(waitingFor('2026-11-01T06:09:30.000Z', now)).toBe('just now');
    expect(waitingFor('2026-11-01T06:04:00.000Z', now)).toBe('6 min');
    expect(waitingFor('2026-11-01T03:00:00.000Z', now)).toBe('3 h');
    expect(waitingFor('2026-10-28T03:00:00.000Z', now)).toBe('28 Oct');
  });

  it('names the assignee on unowned escalated rows only', () => {
    expect(escalationText(escalated, ME, now)).toBe('For Mei Ling · 6 min');
    expect(escalationText(escalated, MEI, now)).toBe('For you · 6 min');
    expect(escalationText({ ...escalated, escalation: esc({ assignee: null }) }, ME, now)).toBe(
      'For a team member · 6 min',
    );
    expect(
      escalationText({ ...escalated, owner: { userId: ME, name: 'Owner' } }, ME, now),
    ).toBeNull();
    expect(escalationText(summary(2), ME, now)).toBeNull();
  });

  it('matches the assignee filter on the owner, else the escalation assignee', () => {
    expect(matchesView(escalated, 'escalated', null, 'me', MEI)).toBe(true);
    expect(matchesView(escalated, 'escalated', null, MEI, ME)).toBe(true);
    expect(matchesView(escalated, 'escalated', null, 'me', ME)).toBe(false);
    expect(matchesView(escalated, 'open', null, 'none', ME)).toBe(false);
    const owned = { ...escalated, owner: { userId: ME, name: 'Owner' } };
    expect(matchesView(owned, 'open', null, 'me', ME)).toBe(true);
    expect(matchesView(owned, 'open', null, MEI, ME)).toBe(false);
    expect(matchesView(summary(3), 'open', null, 'none', ME)).toBe(true);
  });

  it('keeps the cached assignee name when the worker could not name them', () => {
    const unnamed = {
      ...escalated,
      escalation: esc({ assignee: { userId: MEI, name: 'A team member' } }),
    };
    expect(keepAssigneeName(unnamed, escalated).escalation?.assignee?.name).toBe('Mei Ling');
    const other = {
      ...escalated,
      escalation: esc({ assignee: { userId: ME, name: 'A team member' } }),
    };
    expect(keepAssigneeName(other, escalated).escalation?.assignee?.name).toBe('A team member');
    const list = applySummary(data([[escalated]], null), unnamed, open, ME);
    expect(flattenPages(list)[0]!.escalation?.assignee?.name).toBe('Mei Ling');
  });

  it('writes the strip and the divider', () => {
    expect(escalationStrip(esc(), ME, now)).toEqual({
      lead: 'Escalated to Mei Ling 6 min ago. The visitor asked for a person.',
      rest: 'The assistant keeps answering until someone takes over.',
      afterHours: null,
      reminders: null,
    });
    const s = escalationStrip(
      esc({ source: 'unverified', afterHours: true, reminders: 2 }),
      MEI,
      now,
    );
    expect(s.lead).toBe(
      "Escalated to you 6 min ago. A reply couldn't be checked, so the assistant asked the team.",
    );
    expect(s.afterHours).toBe('Asked after hours; the visitor was told when you open.');
    expect(s.reminders).toBe('Reminded 2 times');
    const divider = {
      at: now.toISOString(),
      kind: 'state' as const,
      to: 'escalated' as const,
      from: 'ai' as const,
      reason: 'escalated' as const,
      actor: { type: 'system' as const, name: null },
      subject: { name: 'Mei Ling' },
      source: 'visitor_asked' as const,
    };
    expect(eventText(divider)).toBe('Escalated to Mei Ling · visitor asked for a person');
    expect(eventText({ ...divider, source: 'unverified' })).toBe(
      "Escalated to Mei Ling · reply couldn't be checked",
    );
  });
});

describe('consent and lead in the thread and sidebar (FEAT-049 AC-12)', () => {
  const at = '2026-11-18T06:30:00.000Z';
  const base = {
    at,
    from: null,
    to: null,
    actor: { type: 'system' as const, name: null },
    subject: null,
  };

  it('words the consent and lead dividers', () => {
    expect(eventText({ ...base, kind: 'consent', reason: 'agreed' })).toBe(
      'Visitor agreed to share their details',
    );
    expect(eventText({ ...base, kind: 'consent', reason: 'declined' })).toBe(
      'Visitor chose not to share their details',
    );
    expect(eventText({ ...base, kind: 'lead', reason: 'created' })).toBe(
      'Visitor left their details',
    );
    expect(eventText({ ...base, kind: 'lead', reason: 'updated' })).toBe(
      'Visitor updated their details',
    );
  });

  it('captions agent bubbles that carried a card', () => {
    expect(cardCaption('consent')).toBe('Asked for consent');
    expect(cardCaption('lead_form')).toBe('Showed the details form');
    expect(cardCaption(null)).toBeNull();
  });

  it("shows the lead's status, consent time and marketing answer in Singapore time", () => {
    const lead = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'new' as const,
      updatedAt: at,
      consent: { enquiryAt: at, marketing: { agreed: true, at } },
    };
    expect(LEAD_STATUS.new).toEqual({ label: 'New', tone: 'info' });
    expect(leadLines(lead)).toEqual({
      consent: 'Consent · 18 Nov 2026, 2:30 pm',
      offers: 'Offers · Yes, 2:30 pm',
    });
    expect(leadLines({ ...lead, consent: { enquiryAt: at, marketing: null } }).offers).toBe(
      'Offers · No',
    );
  });
});
