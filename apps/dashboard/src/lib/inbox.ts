import type {
  CloseReason,
  ConversationList,
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  InboxView,
  IntentSignal,
  Me,
  OpenEscalation,
  MemberEvent,
  Message,
  ThreadEvent,
  ThreadMessage,
  LeadSummary,
  ConversationChannel,
  MessageAttachment,
  MessageDelivery,
  WebContext,
} from '@kaki/contracts';
import type { InfiniteData } from '@tanstack/react-query';

/** The inbox's filters, read from and written to the URL (FEAT-042 §5.5). */
export interface InboxFilter {
  view: InboxView;
  channel: ConversationChannel | null;
  /** FEAT-043 (D7): the current owner, `me`, `none` (unassigned) or a member's user ID; null = anyone. */
  assignee: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validAssignee = (a: string | null) =>
  a === 'me' || a === 'none' || (a !== null && UUID.test(a)) ? a : null;

export const VIEWS: InboxView[] = ['open', 'escalated', 'approval', 'flagged', 'closed'];
export const VIEW_LABEL: Record<InboxView, string> = {
  open: 'Open',
  escalated: 'Escalated',
  approval: 'Waiting for approval',
  flagged: 'Flagged',
  closed: 'Closed',
};
export const CHANNEL_LABEL: Record<ConversationSummary['channel'], string> = {
  widget: 'Website chat',
  email: 'Email',
  telegram: 'Telegram',
};

/** The channel filter's options, in order (FEAT-036 adds Email, FEAT-037 Telegram after it). */
export const CHANNELS: ConversationChannel[] = ['widget', 'email', 'telegram'];
/** A URL or cache-key value as a channel filter; anything else is all channels. */
export const channelOf = (v: string | null | undefined): ConversationChannel | null =>
  (CHANNELS as (string | null | undefined)[]).includes(v) ? (v as ConversationChannel) : null;

/** Who a row or thread is with when there's no contact name: by channel. */
export const PARTY_LABEL: Record<ConversationChannel, string> = {
  widget: 'Website visitor',
  email: 'Email customer',
  telegram: 'Telegram customer',
};

export function viewFromSearch(search: URLSearchParams): InboxFilter {
  const v = search.get('view');
  const view = (VIEWS as string[]).includes(v ?? '') ? (v as InboxView) : 'open';
  const channel = channelOf(search.get('channel'));
  return { view, channel, assignee: validAssignee(search.get('assignee')) };
}

/** The query string for a filter; the default (Open, all channels) is empty, so the URL is `/inbox`. */
export function searchFromView(filter: InboxFilter): string {
  const params = new URLSearchParams();
  if (filter.view !== 'open') params.set('view', filter.view);
  if (filter.channel) params.set('channel', filter.channel);
  if (filter.assignee) params.set('assignee', filter.assignee);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const listKey = (f: InboxFilter) =>
  ['conversations', f.view, f.channel ?? 'all', f.assignee ?? 'any'] as const;
/** The filter a cached list key was made from (`listKey`'s inverse). */
export function filterOfKey(key: readonly unknown[]): InboxFilter {
  const [, view, channel, assignee] = key as [string, InboxView, string, string | undefined];
  return {
    view,
    channel: channelOf(channel),
    assignee: assignee && assignee !== 'any' ? assignee : null,
  };
}
export const MEMBERS_KEY = ['inbox-members'] as const;
export const COUNTS_KEY = ['inbox-counts'] as const;
export const threadKey = (id: string) => ['conversation', id] as const;

export function matchesView(
  s: ConversationSummary,
  view: InboxView,
  channel: ConversationChannel | null,
  assignee: string | null = null,
  meId: string | null = null,
): boolean {
  if (channel && s.channel !== channel) return false;
  // Who has it: the owner, else the open escalation's assignee (FEAT-044 AC-7).
  const holder = s.owner?.userId ?? s.escalation?.assignee?.userId ?? null;
  if (assignee === 'none' && holder) return false;
  if (assignee && assignee !== 'none' && holder !== (assignee === 'me' ? meId : assignee))
    return false;
  switch (view) {
    case 'open':
      return s.status !== 'closed';
    case 'escalated':
      return s.status === 'escalated';
    case 'approval':
      return s.status === 'waiting_approval';
    case 'flagged':
      return s.flaggedAt !== null;
    case 'closed':
      return s.status === 'closed';
  }
}

/** Newest activity first, then ID descending: the server's keyset order. */
function before(a: ConversationSummary, b: ConversationSummary): boolean {
  if (a.lastMessageAt !== b.lastMessageAt)
    return new Date(a.lastMessageAt).getTime() > new Date(b.lastMessageAt).getTime();
  return a.id > b.id;
}

/**
 * Patches a cached list with a changed conversation: removed everywhere, then put back
 * in its sorted place when it still matches the view. A row that sorts after every
 * loaded row is left for Load more, unless the list is complete.
 */
export function applySummary(
  data: InfiniteData<ConversationList, unknown> | undefined,
  summary: ConversationSummary,
  filter: InboxFilter,
  meId: string | null = null,
): InfiniteData<ConversationList, unknown> | undefined {
  if (!data) return data;
  const cached = data.pages.flatMap((p) => p.conversations).find((c) => c.id === summary.id);
  summary = keepAssigneeName(summary, cached);
  const pages = data.pages.map((p) => ({
    ...p,
    conversations: p.conversations.filter((c) => c.id !== summary.id),
  }));
  if (matchesView(summary, filter.view, filter.channel, filter.assignee, meId)) {
    let placed = false;
    for (const page of pages) {
      const at = page.conversations.findIndex((c) => before(summary, c));
      if (at >= 0) {
        page.conversations.splice(at, 0, summary);
        placed = true;
        break;
      }
    }
    const last = pages.at(-1);
    if (!placed && last && last.nextCursor === null) last.conversations.push(summary);
  }
  return { ...data, pages };
}

/**
 * Summaries the agent-worker publishes can't name the assignee (visitor zone): keep the
 * name already cached for the same person (FEAT-044 handoff).
 */
export function keepAssigneeName(
  summary: ConversationSummary,
  cached: ConversationSummary | undefined,
): ConversationSummary {
  const next = summary.escalation?.assignee;
  const prev = cached?.escalation?.assignee;
  if (!next || !prev || next.userId !== prev.userId || next.name === prev.name) return summary;
  if (next.name && next.name !== TEAM_MEMBER) return summary;
  return { ...summary, escalation: { ...summary.escalation!, assignee: prev } };
}

const TEAM_MEMBER = 'A team member';

/** Every loaded row once, in order (a row can move between pages while paging). */
export function flattenPages(data: InfiniteData<ConversationList, unknown> | undefined) {
  const seen = new Set<string>();
  const out: ConversationSummary[] = [];
  for (const page of data?.pages ?? [])
    for (const c of page.conversations)
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
  return out;
}

/** A live message added to the open thread, by `seq`, once. */
export function appendMessage(
  thread: ConversationThread | undefined,
  message: Message | ThreadMessage,
): ConversationThread | undefined {
  if (!thread || message.conversationId !== thread.conversation.id) return thread;
  // A known message: only its delivery can change (FEAT-036: sending → sent or failed, retry).
  if (thread.messages.some((m) => m.id === message.id)) {
    if (message.delivery === undefined) return thread;
    return {
      ...thread,
      messages: thread.messages.map((m) =>
        m.id === message.id ? { ...m, delivery: message.delivery } : m,
      ),
    };
  }
  if (thread.messages.some((m) => m.seq === message.seq)) return thread;
  const card = message.card;
  const next: ThreadMessage = {
    factIds: [],
    authorUserId: null,
    ...message,
    card: typeof card === 'object' && card ? card.kind : (card ?? null),
  };
  const messages = [...thread.messages, next].sort((a, b) => a.seq - b.seq);
  return {
    ...thread,
    messages,
    conversation: {
      ...thread.conversation,
      lastMessage: next.body,
      lastMessageAt: next.createdAt,
    },
  };
}

/** Merges earlier pages with the latest one, by `seq`, deduped. */
export function mergeMessages(earlier: ThreadMessage[], latest: ThreadMessage[]) {
  const bySeq = new Map<number, ThreadMessage>();
  for (const m of [...earlier, ...latest]) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export const STATE_LABEL: Record<ConversationStatus, string> = {
  ai: 'AI handling',
  escalated: 'Escalated',
  human: 'Human',
  waiting_approval: 'Waiting for approval',
  closed: 'Closed',
};
/** The token family of each state's chip (`--color-conversation-<key>-fg/-bg`). */
export const STATE_TOKEN: Record<ConversationStatus, string> = {
  ai: 'ai',
  escalated: 'escalated',
  human: 'human',
  waiting_approval: 'approval',
  closed: 'closed',
};
export const STATE_ICON: Record<ConversationStatus, string> = {
  ai: 'bot',
  escalated: 'alert-triangle',
  human: 'user',
  waiting_approval: 'clock',
  closed: 'check-circle',
};
export const stateLabel = (s: ConversationStatus) => STATE_LABEL[s];

/** The close reason inside a sentence: "Closed {text}". */
export function closeReasonText(reason: CloseReason | null): string {
  switch (reason) {
    case 'staff':
      return 'by your team';
    case 'inactive':
      return 'after 30 minutes without messages';
    case 'visitor':
      return 'by the visitor';
    case 'abuse':
      return 'by the assistant after repeated abuse';
    default:
      return '';
  }
}

const INTENT_LABEL: Record<IntentSignal, string> = {
  asked_questions: 'Asked questions',
  wants_to_order: 'Wants to order or book',
  left_details: 'Left contact details',
  asked_for_person: 'Asked for a person',
  switch_channel: 'Wants another channel',
  privacy_request: 'Privacy request',
  out_of_scope: 'Out of scope',
  abuse: 'Abuse',
  crisis: 'Crisis message',
};
export const intentLabel = (s: IntentSignal) => INTENT_LABEL[s];

/** A thread divider's text, without its time (ui-design SCR-APP-015, Dividers). */
export function eventText(e: ThreadEvent): string {
  // Consent and lead dividers (FEAT-049 ui-design SCR-APP-014).
  if (e.kind === 'consent')
    return e.reason === 'declined'
      ? 'Visitor chose not to share their details'
      : 'Visitor agreed to share their details';
  if (e.kind === 'lead')
    return e.reason === 'updated' ? 'Visitor updated their details' : 'Visitor left their details';
  // Approval dividers (FEAT-055 ui-design SCR-APP-014).
  if (e.kind === 'approval_drafted')
    return e.reason === 'auto'
      ? 'Assistant sent a quote within your rules'
      : 'Assistant asked the team to approve a quote';
  if (e.kind === 'approval_expired') return 'The approval expired';
  if (e.kind === 'approval_decided') {
    const by = e.actor.name ?? 'A team member';
    if (e.reason === 'edited_approved') return `${by} approved the quote with edits`;
    if (e.reason === 'rejected') return `${by} rejected the request`;
    if (e.reason === 'undeliverable')
      return `${by} approved the quote, but the visitor couldn't be reached`;
    return `${by} approved the quote`;
  }
  if (e.kind === 'flagged')
    return e.reason === 'crisis' ? 'Flagged: crisis message' : 'Flagged: abuse';
  // Continue elsewhere (FEAT-038 ui-design SCR-APP-015).
  if (e.kind === 'moved') return e.channel === 'email' ? 'Moved to email' : 'Moved to Telegram';
  const who = e.actor.name ?? 'A team member';
  const whom = e.subject?.name ?? 'a team member';
  switch (e.reason) {
    case 'taken_over':
      return `${who} took over`;
    case 'handed_back':
      return `${who} handed back to the assistant`;
    case 'taken_from':
      return `${who} took over from ${whom}`;
    case 'handover_requested':
      return `${who} asked ${whom} to hand over`;
    case 'escalated':
      return `Escalated to ${e.subject?.name ?? 'a team member'} · ${
        e.source === 'unverified'
          ? "reply couldn't be checked"
          : e.source === 'data_request'
            ? 'visitor asked about their personal data'
            : 'visitor asked for a person'
      }`;
  }
  if (e.to === 'closed') {
    switch (e.reason) {
      case 'staff':
        return `Closed by ${who}`;
      case 'inactive':
        return 'Closed after 30 minutes without messages';
      case 'visitor':
        return 'Visitor ended the chat';
      case 'abuse':
        return 'Assistant stopped: repeated abuse';
    }
    return 'Closed';
  }
  if (e.reason === 'reopened') return 'Reopened by a new visitor message';
  if (e.to === 'escalated') return 'Escalated';
  if (e.to === 'waiting_approval') return 'Waiting for approval';
  if (e.to === 'ai' && e.from !== null) return 'Handed back to the assistant';
  return `Status changed to ${e.to ? STATE_LABEL[e.to] : 'unknown'}`;
}

export type DockMode = 'ai' | 'mine' | 'other' | 'closed';

/**
 * What the dock shows (FEAT-043 §5.5): the takeover bar while the assistant has it, the
 * composer for the owner, the owned bar for everyone else, the closed text.
 */
export function dockMode(
  c: Pick<ConversationSummary, 'status' | 'owner'>,
  me: Pick<Me, 'user'> | undefined,
): DockMode {
  if (c.status === 'closed') return 'closed';
  if (c.owner) return c.owner.userId === me?.user.id ? 'mine' : 'other';
  return c.status === 'human' ? 'other' : 'ai';
}

/** The owner's name as staff see it: "You" for yourself, "A team member" when unknown. */
export function ownerText(
  owner: ConversationSummary['owner'],
  meId: string | null | undefined,
): string {
  if (!owner) return 'A team member';
  return owner.userId === meId ? 'You' : owner.name || 'A team member';
}

/**
 * The alert for a refused take-over, hand-back, reply or request (ui-design SCR-APP-015);
 * null for an error that gets the action's generic text.
 */
export function takeoverErrorText(code: string, details: Record<string, unknown>): string | null {
  const owner = (details.owner ??
    (details.conversation as ConversationSummary | undefined)?.owner) as
    ConversationSummary['owner'] | undefined;
  const name = owner?.name || 'A team member';
  const conv = details.conversation as ConversationSummary | undefined;
  switch (code) {
    case 'owned':
      return `${name} took this over just now.`;
    case 'state_changed':
      return `This conversation changed while you were looking. It's now ${
        conv ? STATE_LABEL[conv.status].toLowerCase() : 'different'
      }.`;
    case 'closed':
    case 'already_closed':
      return 'This conversation was closed.';
    case 'not_owner':
      return `${name} has taken over this conversation. Your reply wasn't sent.`;
    case 'not_owned':
      return "It's back with the assistant. You can take it over.";
    case 'already_owner':
      return "You're already handling this conversation.";
    default:
      return null;
  }
}

/** The dock under the thread, per state (FEAT-043 replaces the AI states' text). */
export function dockText(c: Pick<ConversationSummary, 'status' | 'closeReason' | 'closedAt'>) {
  switch (c.status) {
    case 'ai':
      return 'The assistant is handling this conversation.';
    case 'escalated':
      return 'The visitor asked for a person. The assistant keeps answering until someone takes over.';
    case 'human':
      return 'A team member is handling this conversation.';
    case 'waiting_approval':
      return 'Waiting for approval. The assistant keeps answering other questions.';
    case 'closed':
      if (c.closeReason === 'visitor' || c.closeReason === 'abuse')
        return "Closed. This chat can't be reopened; the visitor can start a new one.";
      return `Closed ${closeReasonText(c.closeReason)}${
        c.closedAt ? ` at ${clockTime(c.closedAt)}` : ''
      }. A new message from the visitor reopens it.`;
  }
}

const TZ = 'Asia/Singapore';
const clock = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TZ,
});
const dayMonth = new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', timeZone: TZ });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const dayMonthYear = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: TZ,
});

export const clockTime = (iso: string) => clock.format(new Date(iso));
export const shortDate = (iso: string) => dayMonth.format(new Date(iso));

/** A row's time: the time today, "Yesterday", else "12 Oct" (Singapore time). */
export function rowTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const key = dayKey.format(d);
  if (key === dayKey.format(now)) return clock.format(d);
  if (key === dayKey.format(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return dayMonth.format(d);
}

/** How long an escalation has waited: "just now", "6 min", "2 h", then the date. */
export function waitingFor(since: string, now = new Date()): string {
  const min = Math.floor((now.getTime() - new Date(since).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h`;
  return dayMonth.format(new Date(since));
}

const assigneeName = (e: OpenEscalation, meId: string | null | undefined, you: string) =>
  e.assignee
    ? e.assignee.userId === meId
      ? you
      : e.assignee.name || 'a team member'
    : 'a team member';

/**
 * An unowned escalated row's line (ui-design SCR-APP-014): "For Mei Ling · 6 min",
 * "For you · …"; null when someone owns it or nothing is escalated.
 */
export function escalationText(
  c: Pick<ConversationSummary, 'owner' | 'escalation'>,
  meId: string | null | undefined,
  now = new Date(),
): string | null {
  if (c.owner || !c.escalation) return null;
  return `For ${assigneeName(c.escalation, meId, 'you')} · ${waitingFor(c.escalation.since, now)}`;
}

/**
 * The escalation strip in the takeover bar (ui-design SCR-APP-015): the lead line, the
 * standing line, and the after-hours and reminders captions when they apply.
 */
export function escalationStrip(
  e: OpenEscalation,
  meId: string | null | undefined,
  now = new Date(),
): { lead: string; rest: string; afterHours: string | null; reminders: string | null } {
  const wait = waitingFor(e.since, now);
  const ago =
    wait === 'just now' ? 'just now' : /\d (min|h)$/.test(wait) ? `${wait} ago` : `on ${wait}`;
  const why =
    e.source === 'unverified'
      ? "A reply couldn't be checked, so the assistant asked the team."
      : e.source === 'data_request'
        ? 'The visitor asked about their personal data.'
        : e.source === 'reply_cap'
          ? 'AI reply limit reached in this email thread.'
          : e.source === 'delivery_failed'
            ? "A reply couldn't be delivered."
            : 'The visitor asked for a person.';
  return {
    lead: `Escalated to ${assigneeName(e, meId, 'you')} ${ago}. ${why}`,
    rest: 'The assistant keeps answering until someone takes over.',
    afterHours: e.afterHours ? 'Asked after hours; the visitor was told when you open.' : null,
    reminders:
      e.reminders > 0 ? `Reminded ${e.reminders} ${e.reminders === 1 ? 'time' : 'times'}` : null,
  };
}

/** Two letters for an avatar ("Website visitor" → "WV"). */
export function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/** The toast's text and link label for an event sent to me (ui-design SCR-APP-015, Owner's notifications). */
export function memberToastText(e: MemberEvent): { text: string; action: string } {
  const by = e.by.name || 'A team member';
  return e.type === 'handover_requested'
    ? { text: `${by} asks you to hand over a conversation.`, action: 'Open conversation' }
    : { text: `${by} took over a conversation you were handling.`, action: 'Open' };
}

// ---- Contact and lead in the sidebar (FEAT-049 ui-design SCR-APP-014) ----------------

export const LEAD_STATUS: Record<LeadSummary['status'], { label: string; tone: string }> = {
  new: { label: 'New', tone: 'info' },
  contacted: { label: 'Contacted', tone: 'accent' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'neutral' },
};

/** "18 Nov 2026, 2:30 pm" (Singapore time). */
export const dateTime = (iso: string) => `${dayMonthYear.format(new Date(iso))}, ${clockTime(iso)}`;

/**
 * The lead section's lines: consent time and the marketing answer; FEAT-051 adds the
 * withdrawn line ("Consent withdrawn · 18 Nov, 2:31 pm") and "Offers: stopped".
 */
export function leadLines(lead: LeadSummary): {
  consent: string;
  offers: string;
  withdrawn: string | null;
} {
  const m = lead.consent.marketing;
  const w = lead.consent.withdrawnAt;
  return {
    consent: `Consent · ${dateTime(lead.consent.enquiryAt)}`,
    offers: m?.withdrawn
      ? 'Offers: stopped'
      : m?.agreed
        ? `Offers · Yes, ${clockTime(m.at)}`
        : 'Offers · No',
    withdrawn: w ? `Consent withdrawn · ${shortDate(w)}, ${clockTime(w)}` : null,
  };
}

/** An agent bubble's caption when it carried a widget card. */
export const cardCaption = (card: ThreadMessage['card']) =>
  card === 'consent'
    ? 'Asked for consent'
    : card === 'lead_form'
      ? 'Showed the details form'
      : card === 'quote'
        ? 'Sent after approval'
        : card === 'withdraw'
          ? 'Asked to confirm the withdrawal'
          : card === 'handoff'
            ? 'Offered to continue on another channel'
            : null;

/**
 * The recap a handoff sent on the new channel (FEAT-038 ui-design SCR-APP-015): its label and
 * its first two lines; `more` when "Show all" has anything to add.
 */
export function recapView(
  text: string,
  channel: ConversationSummary['channel'] | undefined,
): { label: string; preview: string; more: boolean } {
  const lines = text.split('\n');
  return {
    label: channel === 'email' ? 'Recap sent by email' : 'Recap sent on Telegram',
    preview: lines.slice(0, 2).join('\n'),
    more: lines.length > 2,
  };
}

/**
 * A Telegram message without text arrives as a placeholder like "[Sticker]" (FEAT-037 D11): the
 * caption's kind ("sticker", "voice message"), or null for an ordinary message.
 */
export function placeholderKind(
  body: string,
  author: ThreadMessage['author'],
  channel: ConversationChannel | undefined,
): string | null {
  if (channel !== 'telegram' || author !== 'visitor') return null;
  const m = /^\[([A-Z][A-Za-z ]{1,30})\]$/.exec(body.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** The thread header's caption line before "· started …" (FEAT-036/037 ui-design). */
export function channelCaption(channel: ConversationChannel, telegramUsername: string | null) {
  if (channel === 'email') return 'By email';
  if (channel === 'telegram')
    return telegramUsername ? `On Telegram · @${telegramUsername}` : 'On Telegram';
  return CHANNEL_LABEL[channel];
}

const FAILED_REASON: Record<NonNullable<MessageDelivery['failedReason']>, string> = {
  bounced: 'the address bounced',
  rejected: 'the email was refused',
  timed_out: "we couldn't send it for 24 hours",
  blocked: 'the customer blocked the bot',
};

/** The delivery line under a staff or AI bubble (FEAT-036 ui-design); null when sent or none. */
export function deliveryText(
  d: MessageDelivery | null | undefined,
): { status: 'sending' | 'failed'; text: string } | null {
  if (!d || d.status === 'sent') return null;
  if (d.status === 'sending') return { status: 'sending', text: 'Sending…' };
  return {
    status: 'failed',
    text: `Not delivered: ${d.failedReason ? FAILED_REASON[d.failedReason] : 'the email was refused'}`,
  };
}

const REJECT_REASON: Record<NonNullable<MessageAttachment['rejectReason']>, string> = {
  unsupported_type: 'file type not allowed',
  too_large: 'over 10 MB',
  malware: 'failed the virus check',
  encrypted: 'password-protected',
  too_many: 'more than 10 files',
};

/** "820 B", "14 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An attachment chip's state line: null for a clean one (it's a download link). */
export function attachmentStatus(a: MessageAttachment): string | null {
  if (a.status === 'clean') return null;
  if (a.status === 'scanning') return 'Checking…';
  return `Not stored: ${a.rejectReason ? REJECT_REASON[a.rejectReason] : 'file type not allowed'}`;
}

/** "under a minute", "3 min", "1 h 5 min" (FEAT-029 ui-design SCR-APP-015). */
export function formatDwell(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (ms < 60_000 || min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const UTM_ORDER = ['source', 'medium', 'campaign', 'term', 'content'] as const;
/** The Source row: UTM keys present, else the referrer host, else "Direct". */
export function sourceLine(source: WebContext['source']): { text: string; mono: boolean } {
  const utm = source?.utm;
  const parts = utm ? UTM_ORDER.filter((k) => utm[k]).map((k) => `utm_${k}=${utm[k]}`) : [];
  if (parts.length) return { text: parts.join(' · '), mono: true };
  if (source?.referrer) return { text: `From ${source.referrer}`, mono: false };
  return { text: 'Direct', mono: false };
}

/** What the Intent block shows for a conversation's web context, by scope (D7). */
export function webRows(web: WebContext) {
  const full = web.scope === 'full';
  // Viewed only when the visitor saw at least one page other than the current one.
  const viewed = full && web.viewed.some((v) => v.path !== web.currentPage) ? web.viewed : [];
  return {
    nowOn: web.currentPage,
    viewed: viewed.slice(0, 10).map((v) => ({ path: v.path, dwell: formatDwell(v.dwellMs) })),
    source: full ? sourceLine(web.source) : null,
    returning: full && web.returning,
    pageOnly: !full,
  };
}
