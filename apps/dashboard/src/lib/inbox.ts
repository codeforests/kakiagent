import type {
  CloseReason,
  ConversationList,
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  InboxView,
  IntentSignal,
  Message,
  ThreadEvent,
  ThreadMessage,
} from '@kaki/contracts';
import type { InfiniteData } from '@tanstack/react-query';

/** The inbox's filters, read from and written to the URL (FEAT-042 §5.5). */
export interface InboxFilter {
  view: InboxView;
  channel: 'widget' | null;
}

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
};

export function viewFromSearch(search: URLSearchParams): InboxFilter {
  const v = search.get('view');
  const view = (VIEWS as string[]).includes(v ?? '') ? (v as InboxView) : 'open';
  const channel = search.get('channel') === 'widget' ? 'widget' : null;
  return { view, channel };
}

/** The query string for a filter; the default (Open, all channels) is empty, so the URL is `/inbox`. */
export function searchFromView(filter: InboxFilter): string {
  const params = new URLSearchParams();
  if (filter.view !== 'open') params.set('view', filter.view);
  if (filter.channel) params.set('channel', filter.channel);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const listKey = (f: InboxFilter) => ['conversations', f.view, f.channel ?? 'all'] as const;
export const COUNTS_KEY = ['inbox-counts'] as const;
export const threadKey = (id: string) => ['conversation', id] as const;

export function matchesView(
  s: ConversationSummary,
  view: InboxView,
  channel: 'widget' | null,
): boolean {
  if (channel && s.channel !== channel) return false;
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
): InfiniteData<ConversationList, unknown> | undefined {
  if (!data) return data;
  const pages = data.pages.map((p) => ({
    ...p,
    conversations: p.conversations.filter((c) => c.id !== summary.id),
  }));
  if (matchesView(summary, filter.view, filter.channel)) {
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
  if (thread.messages.some((m) => m.id === message.id || m.seq === message.seq)) return thread;
  const next: ThreadMessage = { factIds: [], ...message };
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
  if (e.kind === 'flagged')
    return e.reason === 'crisis' ? 'Flagged: crisis message' : 'Flagged: abuse';
  const who = e.actor.name ?? 'A team member';
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

/** Two letters for an avatar ("Website visitor" → "WV"). */
export function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}
