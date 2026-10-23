import type { ChatMessage } from './messages.js';
import { createRedactor, type RedactionCounts } from './redact.js';

/** A name compared for matching: NFKC, lower case, no emoji or punctuation, single spaces. */
export const normaliseName = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether a sender is the business (FEAT-017 §5.3 step 4, D4): its normalised name equals
 * or contains one of the owner's names (3 or more characters), or it is the account of a
 * Telegram full export.
 */
export function isBusinessSender(
  m: Pick<ChatMessage, 'sender' | 'senderId'>,
  businessNames: string[],
  businessIds: string[],
): boolean {
  if (m.senderId && businessIds.includes(m.senderId)) return true;
  const sender = normaliseName(m.sender);
  if (!sender) return false;
  return businessNames
    .map(normaliseName)
    .some((n) => n.length >= 3 && (sender === n || sender.includes(n)));
}

export interface ChatPart {
  /** 1-based, in the order stored (`chat/<n>`). */
  number: number;
  /** Redacted lines, `Customer: …` or `Business: …`. */
  content: string;
  from: Date;
  to: Date;
}

export interface Grouped {
  parts: ChatPart[];
  /** Exchanges after the part limit, not stored. */
  partsSkipped: number;
  exchanges: number;
  businessMessages: number;
  redacted: RedactionCounts;
}

export const PART_CHARS = 4000;
/** Telegram's sender for a deleted account: not a name. */
const DELETED_ACCOUNT = 'Deleted account';

/** The latest `limit` messages, by time (D9), and how many earlier ones were left out. */
export function keepLatest(messages: ChatMessage[], limit: number) {
  if (messages.length <= limit) return { messages, skipped: 0 };
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  return { messages: sorted.slice(-limit), skipped: sorted.length - limit };
}
export const EXCHANGE_WINDOW_MS = 48 * 3600_000;

type Side = 'Customer' | 'Business';
interface Turn {
  side: Side;
  texts: string[];
  first: Date;
  last: Date;
}

/**
 * Redacts and groups the messages (FEAT-017 §5.3 steps 5–6): per conversation, a side's
 * consecutive messages are a turn; an exchange is a customer turn answered by a business
 * turn within 48 hours. Consecutive exchanges of one conversation are packed into parts of
 * up to 4,000 characters (D3), at most `partLimit`; one message is one line. Messages
 * outside an exchange aren't kept. Returns null when no message is the business's.
 */
export function groupExchanges(
  messages: ChatMessage[],
  opts: { businessNames: string[]; businessIds: string[]; partLimit: number },
): Grouped | null {
  const isBusiness = (m: ChatMessage) => isBusinessSender(m, opts.businessNames, opts.businessIds);
  const businessMessages = messages.filter(isBusiness).length;
  if (businessMessages === 0) return null;
  const customers = new Set<string>();
  for (const m of messages) {
    if (!isBusiness(m) && m.sender !== DELETED_ACCOUNT) customers.add(m.sender);
    for (const n of m.mentions ?? []) customers.add(n);
  }
  const redacted: RedactionCounts = { names: 0, phones: 0, emails: 0, ids: 0, addresses: 0 };
  const redact = createRedactor([...customers], opts.businessNames);

  const byConversation = new Map<number, ChatMessage[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversation) ?? [];
    list.push(m);
    byConversation.set(m.conversation, list);
  }

  const parts: ChatPart[] = [];
  let partsSkipped = 0;
  let exchanges = 0;
  for (const [, list] of [...byConversation].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    const turns: Turn[] = [];
    for (const m of list) {
      const side: Side = isBusiness(m) ? 'Business' : 'Customer';
      const text = redact(m.text, redacted)
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      if (!text) continue;
      const last = turns.at(-1);
      if (last && last.side === side) {
        last.texts.push(text);
        last.last = m.at;
      } else turns.push({ side, texts: [text], first: m.at, last: m.at });
    }
    let current: { lines: string[]; from: Date; to: Date } | null = null;
    const flush = () => {
      if (!current) return;
      if (parts.length < opts.partLimit)
        parts.push({
          number: parts.length + 1,
          content: current.lines.join('\n'),
          from: current.from,
          to: current.to,
        });
      else partsSkipped++;
      current = null;
    };
    for (let i = 0; i + 1 < turns.length; i++) {
      const q = turns[i]!;
      const a = turns[i + 1]!;
      if (q.side !== 'Customer' || a.side !== 'Business') continue;
      if (a.first.getTime() - q.last.getTime() > EXCHANGE_WINDOW_MS) continue;
      exchanges++;
      i++;
      const lines = [
        ...q.texts.map((t) => `Customer: ${t}`),
        ...a.texts.map((t) => `Business: ${t}`),
      ];
      let text = lines.join('\n');
      if (text.length > PART_CHARS) text = text.slice(0, PART_CHARS);
      const c = current as { lines: string[]; from: Date; to: Date } | null;
      if (c && c.lines.join('\n').length + 1 + text.length > PART_CHARS) flush();
      if (!current) current = { lines: [], from: q.first, to: a.last };
      const cur = current as { lines: string[]; from: Date; to: Date };
      cur.lines.push(text);
      cur.to = a.last;
    }
    flush();
  }
  return { parts, partsSkipped, exchanges, businessMessages, redacted };
}
