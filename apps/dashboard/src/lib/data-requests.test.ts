import type { DsrFindResult } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  countsText,
  dsrErrorText,
  dueText,
  emptyDraft,
  IDENTIFIER_REQUIRED,
  nothingPicked,
  otherText,
  personCounts,
  pickedCounts,
  pickedText,
  recoveryOf,
  removedText,
  requesterLabel,
  rowLabel,
  selectionBody,
  selectionFrom,
  validateDraft,
} from './data-requests.ts';

const TODAY = '2026-11-20';

describe('dueText', () => {
  it('shows a caption while there is time, in SGT days', () => {
    expect(dueText({ dueOn: '2026-12-20', dueState: 'ok' }, TODAY)).toEqual({
      text: 'Due 20 Dec',
      tone: 'caption',
    });
  });
  it('counts down when due soon', () => {
    expect(dueText({ dueOn: '2026-11-25', dueState: 'due_soon' }, TODAY)).toEqual({
      text: 'Due in 5 days',
      tone: 'warning',
    });
    expect(dueText({ dueOn: '2026-11-21', dueState: 'due_soon' }, TODAY)?.text).toBe(
      'Due tomorrow',
    );
    expect(dueText({ dueOn: TODAY, dueState: 'due_soon' }, TODAY)?.text).toBe('Due today');
  });
  it('counts the days overdue', () => {
    expect(dueText({ dueOn: '2026-11-18', dueState: 'overdue' }, TODAY)).toEqual({
      text: 'Overdue by 2 days',
      tone: 'danger',
    });
    expect(dueText({ dueOn: '2026-11-19', dueState: 'overdue' }, TODAY)?.text).toBe(
      'Overdue by 1 day',
    );
  });
  it('shows nothing once closed', () => {
    expect(dueText({ dueOn: '2026-11-18', dueState: 'closed' }, TODAY)).toBeNull();
  });
});

describe('requesterLabel', () => {
  it('joins what is held, phone spaced', () => {
    expect(
      requesterLabel({ name: 'Mei Tan', email: 'mei@example.com', phone: '+6591234567' }),
    ).toBe('Mei Tan · mei@example.com · +65 9123 4567');
    expect(requesterLabel({ telegramId: '1234' })).toBe('Telegram 1234');
    expect(requesterLabel({ name: null, email: null })).toBe('No details');
  });
});

describe('row and counts', () => {
  it('names the row by ref, type, status and due', () => {
    expect(
      rowLabel(
        {
          id: '00000000-0000-4000-8000-000000000001',
          ref: 'DSR-1A2B3C4D',
          type: 'deletion',
          status: 'open',
          source: 'dashboard',
          receivedOn: '2026-10-22',
          dueOn: '2026-11-21',
          dueState: 'due_soon',
          requesterLabel: 'm•••@gmail.com',
          createdAt: '2026-10-22T02:00:00Z',
        },
        TODAY,
      ),
    ).toBe('DSR-1A2B3C4D, Deletion, Open, Due tomorrow');
  });
  it('says the open and due-soon counts', () => {
    expect(countsText({ open: 2, dueSoon: 1, overdue: 0 })).toBe('2 open · 1 due soon');
    expect(countsText({ open: 0, dueSoon: 0, overdue: 0 })).toBe('0 open');
  });
});

describe('validateDraft', () => {
  it('needs a type and an identifier', () => {
    const e = validateDraft(emptyDraft(TODAY), TODAY);
    expect(e.type).toBeTruthy();
    expect(e.email).toBe(IDENTIFIER_REQUIRED);
    expect(e.receivedOn).toBeUndefined();
  });
  it('refuses a future date, a bad phone and a non-numeric Telegram ID', () => {
    const e = validateDraft(
      {
        ...emptyDraft(TODAY),
        type: 'access',
        receivedOn: '2026-11-21',
        phone: '12',
        telegramId: '@mei',
      },
      TODAY,
    );
    expect(e.receivedOn).toBe("The date can't be in the future");
    expect(e.phone).toBe('Enter a Singapore number like 9123 4567');
    expect(e.telegramId).toBe('A Telegram ID is digits only');
    expect(e.email).toBeUndefined();
  });
  it('passes with one good identifier', () => {
    expect(
      validateDraft({ ...emptyDraft(TODAY), type: 'deletion', phone: '9123 4567' }, TODAY),
    ).toEqual({});
  });
});

const C1 = '00000000-0000-4000-8000-0000000000c1';
const V1 = '00000000-0000-4000-8000-0000000000a1';
const V2 = '00000000-0000-4000-8000-0000000000a2';
const F1 = '00000000-0000-4000-8000-0000000000f1';
const find: DsrFindResult = {
  searchedFor: { email: 'mei@example.com' },
  contacts: [
    {
      id: C1,
      name: 'Mei',
      email: 'mei@example.com',
      phone: null,
      telegram: null,
      mergedFrom: 1,
      identities: 2,
      leads: [],
      consents: 2,
      conversations: 1,
      auditPii: 4,
    },
  ],
  conversations: [
    {
      id: V1,
      channel: 'email',
      startedAt: '2026-11-01T00:00:00Z',
      lastMessageAt: '2026-11-02T00:00:00Z',
      messages: 7,
      attachments: 1,
      contactId: C1,
      match: 'contact',
    },
    {
      id: V2,
      channel: 'widget',
      startedAt: '2026-11-03T00:00:00Z',
      lastMessageAt: '2026-11-03T00:00:00Z',
      messages: 3,
      attachments: 0,
      contactId: null,
      match: 'mention',
    },
  ],
  attachments: [
    {
      id: '00000000-0000-4000-8000-0000000000b1',
      conversationId: V1,
      name: 'quote.pdf',
      size: 2048,
      contentType: 'application/pdf',
      status: 'clean',
    },
  ],
  kb: [
    { kind: 'fact', id: F1, title: 'Owner contact', excerpt: 'm•••@example.com', sourceName: null },
  ],
  other: {
    approvals: 1,
    escalations: 0,
    suggestions: 2,
    summaries: 1,
    trackingEvents: 5,
    telegramChats: 0,
  },
};

describe('selection', () => {
  it('ticks the people (and their conversations) but not mentions or knowledge', () => {
    const picked = selectionFrom(find);
    expect(selectionBody(find, picked)).toEqual({
      contactIds: [C1],
      conversationIds: [V1],
      factIds: [],
      stagedFactIds: [],
    });
    const c = pickedCounts(find, picked);
    expect(pickedText(c)).toBe('1 person, 1 conversation, 1 file');
    expect(pickedText(c, true)).toBe('1 person, 1 conversation (7 messages), 1 file');
  });
  it('adds a mention and a fact when ticked; nothing when all are unticked', () => {
    const picked = { contactIds: [], conversationIds: [V2], factIds: [F1], stagedFactIds: [] };
    expect(pickedText(pickedCounts(find, picked))).toBe('1 conversation, 1 knowledge item');
    const none = { contactIds: [], conversationIds: [], factIds: [], stagedFactIds: [] };
    expect(nothingPicked(pickedCounts(find, none))).toBe(true);
  });
  it('drops IDs no longer in the result', () => {
    const picked = { contactIds: ['gone'], conversationIds: [], factIds: ['x'], stagedFactIds: [] };
    expect(selectionBody(find, picked).contactIds).toEqual([]);
    expect(selectionBody(find, picked).factIds).toEqual([]);
  });
  it('words the counts', () => {
    expect(personCounts(find.contacts[0]!)).toBe(
      '1 conversation · 0 leads · 2 consents · 1 merged record · personal data in 4 audit entries',
    );
    expect(otherText(find.other)).toBe(
      '1 approval · 0 escalations · 2 suggested replies · 1 memory note · 5 page-view records · 0 chat links',
    );
    expect(
      removedText({ contacts: 1, conversations: 4, messages: 120, email_attachments: 2, facts: 1 }),
    ).toBe('1 person, 4 conversations, 120 messages, 2 files, 1 knowledge item');
  });
});

describe('errors', () => {
  it('maps the API codes to words and a recovery', () => {
    const stale = new ApiError(409, 'state_changed', 'x');
    expect(dsrErrorText(stale)).toBe('This request changed. Reload to see the latest.');
    expect(recoveryOf(stale)).toBe('reload');
    const moved = new ApiError(422, 'not_in_result', 'x');
    expect(dsrErrorText(moved)).toBe('The data found has changed. Search again before deleting.');
    expect(recoveryOf(moved)).toBe('search');
    expect(dsrErrorText(new ApiError(403, 'forbidden', 'x'))).toBe(
      "You don't have permission to do this.",
    );
  });
});
