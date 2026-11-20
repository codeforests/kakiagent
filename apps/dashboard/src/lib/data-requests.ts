import {
  isEmail,
  normaliseSgPhone,
  sgToday,
  type DsrDetail,
  type DsrFindResult,
  type DsrSelection,
  type DsrStatus,
  type DsrSummary,
  type DsrType,
  type DsrVerifyMethod,
} from '@kaki/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/**
 * Data-subject requests (SCR-APP-048/049; FEAT-061 ui-design "Shared words"): labels, due
 * texts, the find selection and its counts, error words, and the queries.
 */

export const TYPE_LABEL: Record<DsrType, string> = {
  access: 'Access',
  correction: 'Correction',
  deletion: 'Deletion',
};

export const TYPE_HINT: Record<DsrType, string> = {
  access: 'They want a copy of their data',
  correction: 'Something we hold is wrong',
  deletion: 'They want their data deleted',
};

export const STATUS_CHIP: Record<DsrStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'neutral' },
  verified: { label: 'Identity verified', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  unverified: { label: 'Closed: not verified', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const VERIFY_METHOD_TEXT: Record<DsrVerifyMethod, string> = {
  verified_channel: 'They wrote from the email or Telegram account we already have',
  email_reply: 'They replied from the email address we hold',
  phone_call: 'We called them on the number we hold',
  in_person: 'In person',
  other: 'Other',
};

const DAY = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});
const DAY_MONTH = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Singapore',
});

const asDate = (value: string) =>
  new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+08:00` : value);

/** "20 Nov 2026" (SGT) from a `YYYY-MM-DD` day or an ISO time. */
export const dsrDay = (value: string) => DAY.format(asDate(value));

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The due chip: ok → a caption "Due 20 Dec"; due soon → warning "Due in 5 days"; overdue →
 * danger "Overdue by 2 days"; closed → none. `today` is Singapore's day.
 */
export function dueText(
  r: Pick<DsrSummary, 'dueOn' | 'dueState'>,
  today: string = sgToday(),
): { text: string; tone: 'caption' | 'warning' | 'danger' } | null {
  const days = daysBetween(today, r.dueOn);
  switch (r.dueState) {
    case 'closed':
      return null;
    case 'overdue':
      return { text: `Overdue by ${plural(Math.max(1, -days), 'day')}`, tone: 'danger' };
    case 'due_soon':
      if (days <= 0) return { text: 'Due today', tone: 'warning' };
      if (days === 1) return { text: 'Due tomorrow', tone: 'warning' };
      return { text: `Due in ${days} days`, tone: 'warning' };
    default:
      return { text: `Due ${DAY_MONTH.format(asDate(r.dueOn))}`, tone: 'caption' };
  }
}

/** "+65 9123 4567" from the stored "+6591234567". */
export function phoneText(phone: string): string {
  const m = /^\+65(\d{4})(\d{4})$/.exec(phone);
  return m ? `+65 ${m[1]} ${m[2]}` : phone;
}

/** The requester in one line: "Mei Tan · mei@example.com · +65 9123 4567 · Telegram 1234". */
export function requesterLabel(r: {
  name?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  telegramId?: string | null | undefined;
}): string {
  const parts = [
    r.name,
    r.email,
    r.phone ? phoneText(r.phone) : null,
    r.telegramId ? `Telegram ${r.telegramId}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(' · ') : 'No details';
}

/** The row's accessible name: "{ref}, {type}, {status}, {due text}". */
export function rowLabel(r: DsrSummary, today?: string): string {
  const due = dueText(r, today);
  return [r.ref, TYPE_LABEL[r.type], STATUS_CHIP[r.status].label, due?.text]
    .filter(Boolean)
    .join(', ');
}

/** "2 open · 1 due soon" for Privacy and data's row. */
export function countsText(c: { open: number; dueSoon: number; overdue: number }): string {
  const parts = [`${c.open} open`];
  if (c.dueSoon) parts.push(`${c.dueSoon} due soon`);
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  return parts.join(' · ');
}

// ---- New / Edit request form -------------------------------------------------------------

export interface RequestDraft {
  type: DsrType | '';
  receivedOn: string;
  name: string;
  email: string;
  phone: string;
  telegramId: string;
  note: string;
}

export type DraftErrors = Partial<
  Record<'type' | 'receivedOn' | 'email' | 'phone' | 'telegramId', string>
>;

export const emptyDraft = (today: string = sgToday()): RequestDraft => ({
  type: '',
  receivedOn: today,
  name: '',
  email: '',
  phone: '',
  telegramId: '',
  note: '',
});

export const draftOf = (d: DsrDetail): RequestDraft => ({
  type: d.type,
  receivedOn: d.receivedOn,
  name: d.requester.name ?? '',
  email: d.requester.email ?? '',
  phone: d.requester.phone ? phoneText(d.requester.phone) : '',
  telegramId: d.requester.telegramId ?? '',
  note: d.note ?? '',
});

export const IDENTIFIER_REQUIRED =
  'Enter an email, phone or Telegram user ID, so we can search for their data';

/** The form's client-side checks (the contract's own rules, in the screen's words). */
export function validateDraft(d: RequestDraft, today: string = sgToday()): DraftErrors {
  const e: DraftErrors = {};
  if (!d.type) e.type = "Choose what they're asking for";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.receivedOn)) e.receivedOn = 'Enter the day you received it';
  else if (d.receivedOn > today) e.receivedOn = "The date can't be in the future";
  const email = d.email.trim();
  if (email && !isEmail(email.toLowerCase())) e.email = 'Enter an email like name@example.com';
  if (d.phone.trim() && normaliseSgPhone(d.phone) === null)
    e.phone = 'Enter a Singapore number like 9123 4567';
  if (d.telegramId.trim() && !/^[0-9]{1,20}$/.test(d.telegramId.trim()))
    e.telegramId = 'A Telegram ID is digits only';
  if (!email && !d.phone.trim() && !d.telegramId.trim()) e.email = IDENTIFIER_REQUIRED;
  return e;
}

export const draftRequester = (d: RequestDraft) => ({
  name: d.name,
  email: d.email,
  phone: d.phone,
  telegramId: d.telegramId,
});

// ---- Find results and the selection -------------------------------------------------------

/** What is ticked: people and conversations (D10: mentions and KB items start unticked). */
export interface Picked {
  contactIds: string[];
  conversationIds: string[];
  factIds: string[];
  stagedFactIds: string[];
}

/** The default selection: every person found; the conversations come with them. */
export function selectionFrom(find: DsrFindResult): Picked {
  return {
    contactIds: find.contacts.map((c) => c.id),
    conversationIds: [],
    factIds: [],
    stagedFactIds: [],
  };
}

/** A conversation goes with a ticked person, so it is ticked and can't be unticked alone. */
export const withPerson = (conv: DsrFindResult['conversations'][number], picked: Picked): boolean =>
  conv.contactId !== null && picked.contactIds.includes(conv.contactId);

export const conversationTicked = (
  conv: DsrFindResult['conversations'][number],
  picked: Picked,
): boolean => withPerson(conv, picked) || picked.conversationIds.includes(conv.id);

export function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);
}

/** The body's selection: ticked conversations (including a person's) still in the result. */
export function selectionBody(find: DsrFindResult, picked: Picked): DsrSelection {
  const ids = new Set(find.contacts.map((c) => c.id));
  const facts = new Set(find.kb.filter((k) => k.kind === 'fact').map((k) => k.id));
  const staged = new Set(find.kb.filter((k) => k.kind === 'staged').map((k) => k.id));
  return {
    contactIds: picked.contactIds.filter((id) => ids.has(id)),
    conversationIds: find.conversations
      .filter((c) => conversationTicked(c, picked))
      .map((c) => c.id),
    factIds: picked.factIds.filter((id) => facts.has(id)),
    stagedFactIds: picked.stagedFactIds.filter((id) => staged.has(id)),
  };
}

export interface PickedCounts {
  people: number;
  conversations: number;
  messages: number;
  files: number;
  kb: number;
}

export function pickedCounts(find: DsrFindResult, picked: Picked): PickedCounts {
  const sel = selectionBody(find, picked);
  const convs = find.conversations.filter((c) => sel.conversationIds.includes(c.id));
  return {
    people: sel.contactIds.length,
    conversations: convs.length,
    messages: convs.reduce((n, c) => n + c.messages, 0),
    files: find.attachments.filter((a) => sel.conversationIds.includes(a.conversationId)).length,
    kb: sel.factIds.length + sel.stagedFactIds.length,
  };
}

export const nothingPicked = (c: PickedCounts) => c.people + c.conversations + c.kb === 0;

/** "1 person, 4 conversations, 2 files, 1 knowledge item"; `withMessages` adds "(120 messages)". */
export function pickedText(c: PickedCounts, withMessages = false): string {
  const parts: string[] = [];
  if (c.people) parts.push(plural(c.people, 'person', 'people'));
  if (c.conversations)
    parts.push(
      plural(c.conversations, 'conversation') +
        (withMessages ? ` (${plural(c.messages, 'message')})` : ''),
    );
  if (c.files) parts.push(plural(c.files, 'file'));
  if (c.kb) parts.push(plural(c.kb, 'knowledge item'));
  return parts.length ? parts.join(', ') : 'Nothing';
}

/** A person's counts: "3 conversations · 1 lead · 2 consents · 1 merged record · …". */
export function personCounts(c: DsrFindResult['contacts'][number]): string {
  const parts = [
    plural(c.conversations, 'conversation'),
    plural(c.leads.length, 'lead'),
    plural(c.consents, 'consent'),
  ];
  if (c.mergedFrom) parts.push(plural(c.mergedFrom, 'merged record'));
  if (c.auditPii)
    parts.push(`personal data in ${plural(c.auditPii, 'audit entry', 'audit entries')}`);
  return parts.join(' · ');
}

/** "Also removed with the person": the stores with no rows of their own to tick. */
export function otherText(o: DsrFindResult['other']): string {
  return [
    plural(o.approvals, 'approval'),
    plural(o.escalations, 'escalation'),
    plural(o.suggestions, 'suggested reply', 'suggested replies'),
    plural(o.summaries, 'memory note'),
    plural(o.trackingEvents, 'page-view record'),
    plural(o.telegramChats, 'chat link'),
  ].join(' · ');
}

/** "Searched for: mei@example.com · +65 9123 4567 · Telegram 1234". */
export function searchedText(s: DsrFindResult['searchedFor']): string {
  return requesterLabel({ email: s.email, phone: s.phone, telegramId: s.telegramId });
}

/** The done state's "Removed" line from the erase counts (by store). */
export function removedText(counts: Record<string, number>): string {
  const n = (k: string) => counts[k] ?? 0;
  const parts: string[] = [];
  if (n('contacts')) parts.push(plural(n('contacts'), 'person', 'people'));
  if (n('conversations')) parts.push(plural(n('conversations'), 'conversation'));
  if (n('messages')) parts.push(plural(n('messages'), 'message'));
  if (n('email_attachments')) parts.push(plural(n('email_attachments'), 'file'));
  const kb = n('facts') + n('kb_staged_facts');
  if (kb) parts.push(plural(kb, 'knowledge item'));
  return parts.length ? parts.join(', ') : 'Nothing';
}

export const sizeText = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// ---- History and errors -------------------------------------------------------------------

export const HISTORY_TEXT: Record<string, string> = {
  'dsr.opened': 'Logged',
  'dsr.updated': 'Edited',
  'dsr.verified': 'Identity verified',
  'dsr.unverified': 'Closed: not verified',
  'dsr.exported': 'Exported',
  'dsr.corrected': 'Details corrected',
  'dsr.erased': 'Data deleted',
  'dsr.objects_removed': 'Files removed',
  'dsr.completed': 'Completed',
  'dsr.closed': 'Closed',
  'audit.pii_erased': 'Personal data in the audit log erased',
};

export const historyText = (code: string) => HISTORY_TEXT[code] ?? code;

export const STALE = 'This request changed. Reload to see the latest.';
export const FIND_CHANGED = 'The data found has changed. Search again before deleting.';

/** The words for a failed action (`{ error }` codes from contracts `DSR_ERRORS`). */
export function dsrErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Couldn't save. Check your connection and try again.";
  if (err.status === 403) return "You don't have permission to do this.";
  switch (err.code) {
    case 'state_changed':
      return STALE;
    case 'not_in_result':
      return FIND_CHANGED;
    case 'nothing_selected':
      return 'Select at least one item first.';
    case 'wrong_type':
      return "This request's type doesn't allow that.";
    case 'too_large':
      return 'That is too much for one file. Untick some conversations and try again.';
    case 'not_found':
      return "This request doesn't exist.";
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Which recovery the alert offers: reload the request, or search again. */
export function recoveryOf(err: unknown): 'reload' | 'search' | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'state_changed' || err.code === 'wrong_type') return 'reload';
  if (err.code === 'not_in_result') return 'search';
  return null;
}

// ---- Queries ------------------------------------------------------------------------------

export const dsrKey = (id: string) => ['data-request', id] as const;
export const findKey = (id: string) => ['data-request', id, 'find'] as const;

export function useDataRequests(view: 'open' | 'closed', enabled = true) {
  return useInfiniteQuery({
    queryKey: ['data-requests', view],
    queryFn: ({ pageParam }) => api.dataRequests(view, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
    enabled,
  });
}

/** While the files are still being removed, refetch every 10 s for up to 2 minutes. */
export function useDataRequest(id: string) {
  return useQuery({
    queryKey: dsrKey(id),
    queryFn: () => api.dataRequest(id),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.objects !== 'pending' || !d.closed) return false;
      return Date.now() - Date.parse(d.closed.at) < 120_000 ? 10_000 : false;
    },
  });
}

export function useDsrFind(id: string, enabled: boolean) {
  return useQuery({
    queryKey: findKey(id),
    queryFn: () => api.findDataRequest(id),
    enabled,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
    refetchOnWindowFocus: false,
  });
}
