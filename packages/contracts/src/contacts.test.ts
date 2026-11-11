import { describe, expect, it } from 'vitest';
import {
  ContactConflict409,
  ContactDetail,
  ContactSearchBody,
  ContactSearchResponse,
  MergeBody,
  MergePreview,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const AT = '2026-11-10T06:05:00.000Z';
const identity = {
  id: ID,
  kind: 'email',
  value: 'mei@example.com',
  verified: true,
  source: 'email',
  firstSeenAt: AT,
} as const;
const side = {
  contactId: ID,
  label: 'Mei',
  identities: [identity],
  conversationCount: 2,
  openLead: { id: ID, need: 'Cake' },
  consent: { enquiry: 'agreed', marketing: null },
} as const;

describe('contacts contracts (FEAT-039 §3)', () => {
  it('round-trips a contact page with every list', () => {
    const detail = {
      id: ID,
      label: 'Mei',
      name: 'Mei',
      firstSeenAt: AT,
      mergedInto: null,
      identities: [identity, { ...identity, kind: 'telegram', value: '@mei', source: 'telegram' }],
      conversations: [
        { id: ID, status: 'ai', startedAt: AT, lastMessageAt: AT, channel: 'telegram' },
      ],
      conversationCount: 1,
      leads: [{ id: ID, status: 'new', need: null, createdAt: AT, supersededBy: OTHER }],
      consents: [],
      duplicates: [
        { contactId: OTHER, label: 'M.', shared: [{ kind: 'phone', value: '+65 9123 4567' }] },
      ],
      merges: [
        {
          mergeId: ID,
          otherContactId: OTHER,
          otherLabel: 'M.',
          at: AT,
          automatic: true,
          by: null,
          undoneAt: null,
          canUndo: true,
          undoBlocked: null,
        },
      ],
      canMerge: true,
    };
    expect(ContactDetail.parse(detail)).toEqual(detail);
    expect(
      ContactDetail.safeParse({ ...detail, identities: [{ ...identity, source: 'sms' }] }).success,
    ).toBe(false);
  });

  it('search needs two characters, takes no extra keys, and trims', () => {
    expect(ContactSearchBody.safeParse({ q: 'm' }).success).toBe(false);
    expect(ContactSearchBody.safeParse({ q: ' m ' }).success).toBe(false);
    expect(ContactSearchBody.safeParse({ q: 'mei', tenantId: ID }).success).toBe(false);
    expect(ContactSearchBody.parse({ q: ' mei ', exclude: ID })).toEqual({ q: 'mei', exclude: ID });
    const hit = {
      contactId: ID,
      label: 'Mei',
      email: null,
      phone: '+65 9123 4567',
      telegramUsername: null,
      lastSeenAt: null,
    };
    expect(ContactSearchResponse.parse({ contacts: [hit] })).toEqual({ contacts: [hit] });
  });

  it('round-trips a preview, a merge body and the conflicts', () => {
    const preview = {
      keep: side,
      merge: { ...side, contactId: OTHER, openLead: null },
      after: {
        identities: [identity],
        conversationCount: 4,
        leadOutcome: 'keep',
        consent: { enquiry: 'withdrawn', marketing: 'agreed' },
      },
    };
    expect(MergePreview.parse(preview)).toEqual(preview);
    expect(MergeBody.safeParse({ otherId: OTHER, automatic: true }).success).toBe(false);
    expect(ContactConflict409.parse({ error: 'undo_blocked', reason: 'survivor_merged' })).toEqual({
      error: 'undo_blocked',
      reason: 'survivor_merged',
    });
  });
});
