import type { ContactMergeEntry, MergePreview } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  consentAfterText,
  consentWarning,
  countText,
  identityLabel,
  leadOutcomeText,
  mergeErrorText,
  mergeRowText,
  searchLine,
  sharedText,
  undoErrorText,
} from './contacts.ts';

describe('identityLabel', () => {
  it('names who verified a verified identifier', () => {
    expect(
      identityLabel({ kind: 'email', value: 'mei@example.com', verified: true, source: 'email' }),
    ).toEqual({ value: 'mei@example.com', chip: 'Verified', caption: 'by their email provider' });
    expect(
      identityLabel({ kind: 'telegram', value: '@mei', verified: true, source: 'telegram' }),
    ).toMatchObject({ chip: 'Verified', caption: 'by Telegram' });
  });
  it('says where an unverified identifier came from', () => {
    expect(
      identityLabel({
        kind: 'phone',
        value: '+65 9123 4567',
        verified: false,
        source: 'lead_form',
      }),
    ).toMatchObject({ chip: 'Not verified', caption: 'typed in the chat form' });
    expect(
      identityLabel({ kind: 'email', value: 'a@b.sg', verified: false, source: 'email' }),
    ).toMatchObject({ chip: 'Not verified', caption: "from email we couldn't check" });
  });
});

describe('leadOutcomeText', () => {
  it('has one line per outcome and nothing for none', () => {
    expect(leadOutcomeText('none', 'R. Tan')).toBeNull();
    expect(leadOutcomeText('keep', 'R. Tan')).toBe('Their open lead stays.');
    expect(leadOutcomeText('move', 'R. Tan')).toBe('The open lead from R. Tan moves here.');
    expect(leadOutcomeText('supersede', 'R. Tan')).toBe(
      "Both have an open lead. R. Tan's is kept as merged and only this contact's stays in your pipeline.",
    );
  });
});

describe('consentAfterText and consentWarning', () => {
  it('words the decision, with Not asked for none', () => {
    expect(consentAfterText('agreed')).toBe('Marketing: Agreed');
    expect(consentAfterText('withdrawn')).toBe('Marketing: Withdrawn');
    expect(consentAfterText(null)).toBe('Marketing: Not asked');
  });
  const side = (label: string, marketing: 'agreed' | 'declined' | null) => ({
    contactId: '00000000-0000-4000-8000-000000000001',
    label,
    identities: [],
    conversationCount: 0,
    openLead: null,
    consent: { enquiry: null, marketing },
  });
  const preview = (keep: 'agreed' | null, after: 'agreed' | 'declined' | null): MergePreview => ({
    keep: side('Rachel Tan', keep),
    merge: side('R. Tan', 'declined'),
    after: {
      identities: [],
      conversationCount: 0,
      leadOutcome: 'none',
      consent: { enquiry: null, marketing: after },
    },
  });
  it('warns only when the result differs from this contact', () => {
    expect(consentWarning(preview('agreed', 'agreed'))).toBeNull();
    expect(consentWarning(preview('agreed', 'declined'))).toBe(
      "Marketing consent changes to Declined because R. Tan's record is newer. Check they're the same person.",
    );
    expect(consentWarning(preview(null, 'declined'))).toContain('changes to Declined');
  });
});

describe('row texts', () => {
  it('lists the shared values', () => {
    expect(
      sharedText([
        { kind: 'email', value: 'rachel@example.com' },
        { kind: 'phone', value: '+65 9123 4567' },
      ]),
    ).toBe('Same email: rachel@example.com · Same phone: +65 9123 4567');
  });
  it('joins a search result line from what is known', () => {
    expect(
      searchLine({
        contactId: '00000000-0000-4000-8000-000000000001',
        label: 'Mei',
        email: 'mei@example.com',
        phone: null,
        telegramUsername: 'mei',
        lastSeenAt: null,
      }),
    ).toBe('mei@example.com · @mei');
  });
  it('names who merged, or automatically', () => {
    const m: ContactMergeEntry = {
      mergeId: '00000000-0000-4000-8000-000000000002',
      otherContactId: '00000000-0000-4000-8000-000000000003',
      otherLabel: 'R. Tan',
      at: '2026-11-10T02:00:00Z',
      automatic: false,
      by: 'Ken',
      undoneAt: null,
      canUndo: true,
      undoBlocked: null,
    };
    expect(mergeRowText(m)).toMatch(/^R\. Tan · .+ · by Ken$/);
    expect(mergeRowText({ ...m, automatic: true, by: null })).toMatch(
      /automatically \(verified details\)$/,
    );
  });
  it('counts with the singular', () => {
    expect(countText(1, 'conversation')).toBe('1 conversation');
    expect(countText(3, 'conversation')).toBe('3 conversations');
  });
});

describe('error texts', () => {
  it('maps merge failures', () => {
    expect(
      mergeErrorText(new ApiError(409, 'not_mergeable', '', { reason: 'merged' }), 'R. Tan'),
    ).toEqual({
      text: 'R. Tan was already merged into another contact. Reload to see where.',
      reload: true,
    });
    expect(mergeErrorText(new ApiError(404, 'not_found', ''), 'R. Tan').text).toBe(
      'That contact no longer exists.',
    );
    expect(mergeErrorText(new TypeError('network'), 'R. Tan')).toEqual({
      text: "We couldn't merge. Try again.",
      reload: false,
    });
  });
  it('maps undo failures', () => {
    expect(
      undoErrorText(new ApiError(409, 'undo_blocked', '', { reason: 'already_undone' })).text,
    ).toBe('Someone already undid this merge.');
    expect(
      undoErrorText(new ApiError(409, 'undo_blocked', '', { reason: 'survivor_merged' })).text,
    ).toContain('Undo that merge first');
  });
});
