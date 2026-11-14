import {
  AUDIT_ACTOR_TYPES,
  AUDIT_GROUP_KEYS,
  type AuditBreakReason,
  type AuditExportBody,
  type AuditGroupKey,
  type AuditLastVerified,
  type AuditQuery,
  type AuditRow,
  type AuditSubject,
  type AuditVerifyResult,
} from '@kaki/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/**
 * SCR-APP-050 Audit log (FEAT-060 ui-design, "Shared words"; GOV-01, GOV-02, UC-32): the
 * filters ↔ URL mapping, event and actor words, verification texts and the data hooks.
 */

type ActorType = (typeof AUDIT_ACTOR_TYPES)[number];

// ---- Filters in the URL (`?from&to&group&actorType&actor&conversation`) -------------------

export interface AuditFilter {
  from?: string;
  to?: string;
  group?: AuditGroupKey;
  actorType?: ActorType;
  /** A member; implies `actorType` `user`. */
  actor?: string;
  conversation?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filters from the URL; anything malformed is dropped, so the API never gets a 400. */
export function auditQueryOf(search: URLSearchParams): AuditFilter {
  const f: AuditFilter = {};
  const from = search.get('from');
  const to = search.get('to');
  if (from && DAY.test(from)) f.from = from;
  if (to && DAY.test(to)) f.to = to;
  if (f.from && f.to && f.to < f.from) delete f.to;
  const group = search.get('group');
  if (group && (AUDIT_GROUP_KEYS as readonly string[]).includes(group))
    f.group = group as AuditGroupKey;
  const actorType = search.get('actorType');
  if (actorType && (AUDIT_ACTOR_TYPES as readonly string[]).includes(actorType))
    f.actorType = actorType as ActorType;
  const actor = search.get('actor');
  if (actor && UUID.test(actor) && (!f.actorType || f.actorType === 'user')) {
    f.actor = actor;
    f.actorType = 'user';
  }
  const conversation = search.get('conversation');
  if (conversation && UUID.test(conversation)) f.conversation = conversation;
  return f;
}

const URL_KEYS = ['from', 'to', 'group', 'actorType', 'actor', 'conversation'] as const;

/** The URL search for a filter (`?…` or ''), in a fixed key order. */
export function auditSearchOf(f: AuditFilter): string {
  const q = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = f[k];
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** A copy of the filter without some keys. */
export function without(f: AuditFilter, ...keys: (keyof AuditFilter)[]): AuditFilter {
  const out = { ...f };
  for (const k of keys) delete out[k];
  return out;
}

/** How many filters are set (the phone "Filters (2)" button); a date range counts once. */
export function filterCount(f: AuditFilter): number {
  return (
    (f.from || f.to ? 1 : 0) + (f.group ? 1 : 0) + (f.actorType ? 1 : 0) + (f.conversation ? 1 : 0)
  );
}

/** The API's filter fields: `actorType` `user` is implied by a member and left out then. */
export function auditApiFilter(f: AuditFilter): Omit<AuditQuery, 'before' | 'limit'> {
  return {
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(f.group ? { group: f.group } : {}),
    ...(f.actorType ? { actorType: f.actorType } : {}),
    ...(f.actor ? { actor: f.actor } : {}),
    ...(f.conversation ? { conversation: f.conversation } : {}),
  };
}

export const dateRangeError = (from: string | undefined, to: string | undefined) =>
  from && to && to < from ? 'End date must be on or after the start date' : undefined;

const sgDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' });
/** `YYYY-MM-DD` in Singapore, `days` before `now`. */
export const sgDate = (now: Date, days = 0) =>
  sgDay.format(new Date(now.getTime() - days * 86_400_000));

export const QUICK_RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7', label: 'Last 7 days', days: 6 },
  { key: '30', label: 'Last 30 days', days: 29 },
] as const;

/** The quick chip a range matches (ending today), else null. */
export function quickRangeOf(f: AuditFilter, now: Date): (typeof QUICK_RANGES)[number] | null {
  if (!f.from || f.to !== sgDate(now)) return null;
  return QUICK_RANGES.find((r) => sgDate(now, r.days) === f.from) ?? null;
}

// ---- Words ---------------------------------------------------------------------------------

export const GROUP_LABEL: Record<AuditGroupKey, string> = {
  conversations: 'Conversations',
  assistant: 'Assistant',
  knowledge: 'Knowledge',
  approvals: 'Approvals and rules',
  contacts: 'Contacts and leads',
  team: 'Team and account',
  settings: 'Settings and channels',
  audit: 'Audit log',
  other: 'Other',
};

/** Every event code written today (technical-design §2), in sentence case. */
export const EVENT_TEXT: Record<string, string> = {
  'agent.dispatch': 'Assistant decided what to do',
  'ai.paused': 'Assistant paused',
  'approval.auto': 'Approved automatically',
  'approval.decided': 'Approval decided',
  'approval.drafted': 'Approval drafted',
  'approval.expired': 'Approval expired',
  'approval.link_opened': 'Approval link opened',
  'audit.exported': 'Audit log exported',
  'audit.pii_erased': 'Personal data erased',
  'audit.verified': 'Audit chain verified',
  'channel.connected': 'Channel connected',
  'channel.degraded': 'Channel stopped working',
  'channel.delivery_retry': 'Delivery retried',
  'channel.disconnected': 'Channel disconnected',
  'channel.domain_added': 'Email domain added',
  'channel.domain_removed': 'Email domain removed',
  'channel.offline_settings': 'After-hours settings changed',
  'channel.reply_cap': 'Reply limit reached',
  'channel.token_replaced': 'Bot token replaced',
  'coach.reanswer': 'Coach answer redone',
  'coach.replay.started': 'Replay started',
  'coach.replay.turn': 'Replay answer',
  'coach.turn': 'Coach answer',
  'consent.recorded': 'Consent recorded',
  'consent.withdrawn': 'Consent withdrawn',
  'contact.merged': 'Contacts merged',
  'contact.unmerged': 'Contact merge undone',
  'conversation.flagged': 'Conversation flagged',
  'conversation.handover_requested': 'Handover requested',
  'conversation.moved': 'Conversation moved',
  'conversation.owner_changed': 'Conversation owner changed',
  'conversation.started': 'Conversation started',
  'correction.proposed': 'Correction proposed',
  'correction.replay.started': 'Correction replay started',
  'escalation.assigned': 'Escalation assigned',
  'escalation.reminded': 'Escalation reminder sent',
  'escalation.routing_updated': 'Escalation routing changed',
  'fact.approved': 'Fact approved',
  'fact.conflict_cleared': 'Fact conflict cleared',
  'fact.conflicted': 'Fact conflict found',
  'fact.created': 'Fact created',
  'fact.deleted': 'Fact deleted',
  'fact.reconfirmed': 'Fact reconfirmed',
  'fact.updated': 'Fact updated',
  'handoff.completed': 'Handoff completed',
  'handoff.requested': 'Handoff requested',
  'inbox.suggestion.created': 'Reply suggested',
  'inbox.suggestion.sent': 'Suggested reply sent',
  'kb.conflict.resolved': 'Knowledge conflict resolved',
  'kb.review.approved_all': 'All facts approved',
  'kb.review_intervals.changed': 'Review intervals changed',
  'kb_source.attested': 'Source rights confirmed',
  'kb_source.created': 'Source added',
  'kb_source.deleted': 'Source deleted',
  'kb_source.import_confirmed': 'Import confirmed',
  'kb_source.parsed': 'Source read',
  'kb_source.promoted': 'Source facts added',
  'kb_source.retried': 'Source retried',
  'lead.exported': 'Leads exported',
  'lead.scored': 'Lead scored',
  'lead.status_changed': 'Lead status changed',
  'member.approval_rights_changed': 'Approval rights changed',
  'member.invite_resent': 'Invitation resent',
  'member.invite_revoked': 'Invitation revoked',
  'member.invited': 'Member invited',
  'member.joined': 'Member joined',
  'member.role_changed': 'Member role changed',
  'message.ai_sent': 'Reply sent by the assistant',
  'message.received': 'Message received',
  'onboarding.first_live': 'Assistant went live',
  'rules.updated': 'Rules updated',
  'settings.assistant_updated': 'Assistant settings changed',
  'settings.lead_fields_updated': 'Lead settings changed',
  'settings.profile_updated': 'Business profile changed',
  'tenant.created': 'Business created',
  'tenant.mfa_policy_changed': 'Two-step policy changed',
  'terms.accepted': 'Terms accepted',
  'tool.lookup_kb': 'Assistant looked up knowledge',
  'tracking.choice': 'Tracking choice recorded',
  'widget.appearance_changed': 'Widget look changed',
  'widget.logo_changed': 'Widget logo changed',
  'widget.origin_added': 'Website allowed',
  'widget.origin_removed': 'Website removed',
  'widget.theme_detect_requested': 'Widget theme check requested',
  'widget.tracking_changed': 'Widget tracking changed',
};

/** "kb_source.parsed" → "Kb source parsed" for a code without its own words. */
export function humanise(code: string): string {
  const s = code.replace(/[._]+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

export const eventText = (code: string) => EVENT_TEXT[code] ?? humanise(code);

const ACTOR_TEXT: Record<Exclude<ActorType, 'user'>, string> = {
  agent: 'Assistant',
  system: 'System',
  visitor: 'Visitor',
  operator: 'KakiAgent support',
};

/** Who did it: the member's name, "Former member", or the actor kind in words. */
export function actorText(row: Pick<AuditRow, 'actorType' | 'actorName'>): string {
  if (row.actorType === 'user') return row.actorName ?? 'Former member';
  return ACTOR_TEXT[row.actorType];
}

const SUBJECT_LABEL: Record<string, string> = {
  conversation: 'Conversation',
  message: 'Message',
  turn: 'Turn',
  fact: 'Fact',
  lead: 'Lead',
  contact: 'Contact',
  approval: 'Approval',
  member: 'Member',
  user: 'Member',
  source: 'Source',
  kb_source: 'Source',
  correction: 'Correction',
  channel: 'Channel',
  tenant: 'Business',
  widget: 'Widget',
};

export const subjectLabel = (type: string) => SUBJECT_LABEL[type] ?? humanise(type);

/** The first 8 characters of an ID, for lists and chips. */
export const shortId = (id: string) => id.slice(0, 8);

/** Where a subject has a screen, its path; else null (not linked). */
export function subjectLink(s: AuditSubject): string | null {
  const id = encodeURIComponent(s.id);
  switch (s.type) {
    case 'conversation':
      return `/inbox/${id}`;
    case 'lead':
      return `/leads/${id}`;
    case 'fact':
      return `/knowledge/facts/${id}`;
    case 'approval':
      return `/approvals/${id}`;
    case 'contact':
      return `/contacts/${id}`;
    default:
      return null;
  }
}

export const BREAK_REASON_TEXT: Record<AuditBreakReason, string> = {
  hash_mismatch: 'This entry was changed after it was written',
  link_mismatch: "This entry doesn't follow the one before it",
  seq_gap: 'An entry is missing before this one',
  anchor_mismatch: "This entry doesn't match the copy stored outside the database",
  truncated: 'Entries after this one were removed',
  pii_commitment_mismatch: 'The personal data linked to this entry was changed',
};

export const breakReasonText = (r: AuditBreakReason) => BREAK_REASON_TEXT[r];

export const PII_TEXT: Record<AuditRow['pii'], string | null> = {
  none: null,
  kept: 'Personal data kept separately',
  erased: 'Personal data erased',
};

const num = new Intl.NumberFormat('en-SG');
export const count = (n: number) => num.format(n);
export const seqText = (seq: number) => `#${num.format(seq)}`;
const entries = (n: number) => `${count(n)} ${n === 1 ? 'entry' : 'entries'}`;

// ---- Times (Singapore) ---------------------------------------------------------------------

const TZ = 'Asia/Singapore';
const clock = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TZ,
});
const clockSec = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: TZ,
});
const dayMonth = new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', timeZone: TZ });
const dayMonthYear = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: TZ,
});

/** List time: "2:14 pm" today, "Yesterday 2:14 pm", else "18 Nov, 2:14 pm". */
export function listTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = sgDay.format(d);
  const t = clock.format(d);
  if (day === sgDate(now)) return t;
  if (day === sgDate(now, 1)) return `Yesterday ${t}`;
  return `${dayMonth.format(d)}, ${t}`;
}

/** Detail time: "18 Nov 2026, 2:14:07 pm". */
export const fullTime = (iso: string) =>
  `${dayMonthYear.format(new Date(iso))}, ${clockSec.format(new Date(iso))}`;

// ---- Entry detail --------------------------------------------------------------------------

/** "price_cents" → "Price cents". */
export const keyText = (k: string) => humanise(k);

/** A payload value as text; objects and arrays become indented JSON (shown in mono). */
export function valueText(v: unknown): { text: string; mono: boolean } {
  if (v === null || v === undefined) return { text: '—', mono: false };
  if (typeof v === 'object') return { text: JSON.stringify(v, null, 2), mono: true };
  if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No', mono: false };
  return { text: String(v), mono: false };
}

// ---- Verification --------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'info';

/** The alert after a verify run on this screen. */
export function verifyText(r: AuditVerifyResult): { tone: Tone; text: string } {
  if (!r.ok && r.broken)
    return {
      tone: 'danger',
      text: `Problem found at entry ${seqText(r.broken.seq)}. ${breakReasonText(r.broken.reason)}.`,
    };
  if (!r.ok) return { tone: 'danger', text: 'Problem found in the audit chain.' };
  if (r.anchors === 'unavailable')
    return {
      tone: 'warning',
      text: "Entries checked, but the copies stored outside the database couldn't be read. Try again later.",
    };
  if (r.anchors === 'none_yet')
    return {
      tone: 'success',
      text: `Chain intact. ${entries(r.checked)} checked. The first outside checkpoint is stored within 15 minutes.`,
    };
  return {
    tone: 'success',
    text: `Chain intact. ${entries(r.checked)} checked against ${count(r.anchorsChecked)} stored ${
      r.anchorsChecked === 1 ? 'checkpoint' : 'checkpoints'
    }.`,
  };
}

/** The entry "Show entry" opens: a gap or truncation points past the last one that exists. */
export function showSeqOf(r: AuditVerifyResult): number | null {
  if (!r.broken) return null;
  if (r.broken.reason === 'truncated') return Math.min(r.broken.seq, r.headSeq);
  return r.broken.seq;
}

/** "Last verified 18 Nov, 2:14 pm by Mei Ling · 12,345 entries". */
export function lastVerifiedText(last: NonNullable<AuditLastVerified['last']>, now = new Date()) {
  const by = last.by ? ` by ${last.by}` : '';
  return `Last verified ${listTime(last.verifiedAt, now)}${by} · ${entries(last.headSeq)}`;
}

/** A verify call that didn't run: cooldown (429) and running elsewhere (409) aren't errors. */
export function verifyBusy(
  err: unknown,
): { kind: 'cooldown'; seconds: number } | { kind: 'running' } | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 409) return { kind: 'running' };
  if (err.status === 429) {
    const s = Number(err.details.retryAfterS);
    return { kind: 'cooldown', seconds: s > 0 ? Math.ceil(s) : 30 };
  }
  return null;
}

export const cooldownText = (seconds: number) =>
  `Verified moments ago. You can check again in ${seconds} s.`;
export const RUNNING_TEXT = 'A check is already running for this business.';

// ---- Export --------------------------------------------------------------------------------

/** "Filters: Last 30 days · Knowledge" or "All entries". */
export function filterSummary(
  f: AuditFilter,
  members: { id: string; name: string }[] = [],
  now = new Date(),
): string {
  const parts: string[] = [];
  const quick = quickRangeOf(f, now);
  if (quick) parts.push(quick.label);
  else if (f.from && f.to) parts.push(f.from === f.to ? f.from : `${f.from} to ${f.to}`);
  else if (f.from) parts.push(`From ${f.from}`);
  else if (f.to) parts.push(`Up to ${f.to}`);
  if (f.group) parts.push(GROUP_LABEL[f.group]);
  if (f.actor) parts.push(members.find((m) => m.id === f.actor)?.name ?? 'One member');
  else if (f.actorType) parts.push(f.actorType === 'user' ? 'Team' : ACTOR_TEXT[f.actorType]);
  if (f.conversation) parts.push(`Conversation ${shortId(f.conversation)}`);
  return parts.length ? `Filters: ${parts.join(' · ')}` : 'All entries';
}

/** `audit-log-YYYY-MM-DD.csv|json` in Singapore (the server's own name wins when sent). */
export const auditFileName = (now: Date, format: 'csv' | 'json') =>
  `audit-log-${sgDate(now)}.${format}`;

/** The dialog's alert for a failed export; null for a cancelled re-auth. */
export function auditExportErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 413) {
    const n = Number(err.details.count);
    return `That's more than 100,000 entries${n > 0 ? ` (${count(n)})` : ''}. Choose a shorter date range.`;
  }
  return "Couldn't export. Try again.";
}

// ---- Data ----------------------------------------------------------------------------------

export const AUDIT_KEY = ['audit'] as const;
const entriesKey = (f: AuditFilter) => ['audit', 'entries', auditSearchOf(f)] as const;

export function useAuditEntries(f: AuditFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: entriesKey(f),
    enabled,
    queryFn: ({ pageParam }) =>
      api.auditEntries({ ...auditApiFilter(f), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** One entry, for "Show entry" on a seq that isn't loaded. */
export function useAuditEntry(seq: number | null, loaded: AuditRow | undefined) {
  return useQuery({
    queryKey: ['audit', 'entry', seq],
    queryFn: () => api.auditEntry(seq!),
    enabled: seq !== null && !loaded,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

export function useAuditFilters(enabled = true) {
  return useQuery({
    queryKey: ['audit', 'filters'],
    queryFn: api.auditFilters,
    enabled,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

export function useLastVerification() {
  return useQuery({
    queryKey: ['audit', 'verification'],
    queryFn: api.auditVerification,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Runs a verify; afterwards the list (a new `audit.verified`) and the last result refetch. */
export function useVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.verifyAudit,
    onSettled: () => void qc.invalidateQueries({ queryKey: AUDIT_KEY }),
  });
}

export const exportBodyOf = (f: AuditFilter, format: 'csv' | 'json'): AuditExportBody => ({
  ...auditApiFilter(f),
  format,
});

/** The detail panel's state from the loaded row or its own fetch. */
export function detailState(
  row: AuditRow | undefined,
  q: { isError: boolean; error: unknown },
): 'loading' | 'not_found' | 'error' | 'ready' {
  if (row) return 'ready';
  if (q.error instanceof ApiError && q.error.status === 404) return 'not_found';
  return q.isError ? 'error' : 'loading';
}
