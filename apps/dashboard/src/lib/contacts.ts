import type {
  ConsentDecision,
  ContactDuplicate,
  ContactIdentity,
  ContactMergeEntry,
  ContactSearchResponse,
  IdentityKind,
  MergePreview,
} from '@kaki/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { dateTime } from './inbox.ts';

/** SCR-APP-016 Contact (FEAT-039 ui-design): data, hooks and the pure label rules. */

export const contactKey = (id: string) => ['contact', id] as const;

export function useContact(id: string) {
  return useQuery({
    queryKey: contactKey(id),
    queryFn: () => api.contact(id),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
    refetchOnWindowFocus: true,
  });
}

export const KIND_LABEL: Record<IdentityKind, string> = {
  email: 'Email',
  phone: 'Phone',
  telegram: 'Telegram',
};

/** One identifier as shown: the value, the chip word and the caption by source (never colour alone). */
export function identityLabel(i: Pick<ContactIdentity, 'kind' | 'value' | 'verified' | 'source'>): {
  value: string;
  chip: 'Verified' | 'Not verified';
  caption: string;
} {
  if (i.verified) {
    return {
      value: i.value,
      chip: 'Verified',
      caption: i.kind === 'telegram' ? 'by Telegram' : 'by their email provider',
    };
  }
  return {
    value: i.value,
    chip: 'Not verified',
    caption:
      i.source === 'lead_form'
        ? 'typed in the chat form'
        : i.source === 'email'
          ? "from email we couldn't check"
          : 'not checked',
  };
}

/** The preview's lead line by `leadOutcome` (D6); null when there's nothing to say. */
export function leadOutcomeText(
  outcome: MergePreview['after']['leadOutcome'],
  other: string,
): string | null {
  switch (outcome) {
    case 'none':
      return null;
    case 'keep':
      return 'Their open lead stays.';
    case 'move':
      return `The open lead from ${other} moves here.`;
    case 'supersede':
      return `Both have an open lead. ${other}'s is kept as merged and only this contact's stays in your pipeline.`;
  }
}

const DECISION_WORD: Record<ConsentDecision, string> = {
  agreed: 'Agreed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export const decisionWord = (d: ConsentDecision | null) => (d ? DECISION_WORD[d] : 'Not asked');

/** "Marketing: Agreed" after the merge (D8: the latest decision across both contacts). */
export const consentAfterText = (d: ConsentDecision | null) => `Marketing: ${decisionWord(d)}`;

/** The warning when the merge changes this contact's marketing consent; null when it doesn't. */
export function consentWarning(p: MergePreview): string | null {
  const after = p.after.consent.marketing;
  if (after === p.keep.consent.marketing) return null;
  return `Marketing consent changes to ${decisionWord(after)} because ${p.merge.label}'s record is newer. Check they're the same person.`;
}

/** "Same email: mei@example.com · Same phone: +65 9123 4567". */
export const sharedText = (shared: ContactDuplicate['shared']) =>
  shared.map((s) => `Same ${KIND_LABEL[s.kind].toLowerCase()}: ${s.value}`).join(' · ');

/** A search result's second line: email, phone and @username, as far as known. */
export function searchLine(r: ContactSearchResponse['contacts'][number]): string {
  const parts = [r.email, r.phone, r.telegramUsername ? `@${r.telegramUsername}` : null].filter(
    Boolean,
  );
  if (r.lastSeenAt) parts.push(`Last seen ${dateTime(r.lastSeenAt).split(',')[0]}`);
  return parts.join(' · ');
}

/** A merges row: "{other} · {date} · by {member}" or "automatically (verified details)". */
export function mergeRowText(m: ContactMergeEntry): string {
  const by = m.automatic || !m.by ? 'automatically (verified details)' : `by ${m.by}`;
  return `${m.otherLabel} · ${dateTime(m.at).split(',')[0]} · ${by}`;
}

/** A failed merge's inline alert; `reload` adds the Reload button. */
export function mergeErrorText(err: unknown, other: string): { text: string; reload: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.details.reason === 'merged')
      return {
        text: `${other} was already merged into another contact. Reload to see where.`,
        reload: true,
      };
    if (err.status === 404) return { text: 'That contact no longer exists.', reload: true };
    if (err.status === 403) return { text: "You can't merge contacts.", reload: false };
  }
  return { text: "We couldn't merge. Try again.", reload: false };
}

/** A failed undo's alert. */
export function undoErrorText(err: unknown): { text: string; reload: boolean } {
  if (err instanceof ApiError && err.status === 409) {
    if (err.details.reason === 'already_undone')
      return { text: 'Someone already undid this merge.', reload: true };
    if (err.details.reason === 'survivor_merged')
      return {
        text: 'This contact was merged into another since. Undo that merge first.',
        reload: true,
      };
  }
  return { text: "We couldn't undo the merge. Try again.", reload: false };
}

/** "{n} conversations" with the singular. */
export const countText = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
