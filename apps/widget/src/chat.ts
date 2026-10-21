import type { Message } from '@kaki/contracts';
import { mergeMessages } from './api.js';

/** A verified sentence of a reply still being written (FEAT-022 §3.4). */
export interface Segment {
  turnId: string;
  seq: number;
  text: string;
}

/**
 * The log's state (SCR-WGT-002): stored messages, plus the segments of turns whose
 * stored reply hasn't arrived. The stored message is the record and replaces them.
 */
export interface Chat {
  messages: Message[];
  /** Segment texts per turn (the visitor message ID), indexed by `seq`. */
  segments: Record<string, string[]>;
}

export const emptyChat: Chat = { messages: [], segments: {} };

const answered = (c: Chat, turnId: string) => c.messages.some((m) => m.inReplyTo === turnId);

export function withMessage(c: Chat, m: Message): Chat {
  const messages = mergeMessages(c.messages, m);
  if (!m.inReplyTo || !(m.inReplyTo in c.segments)) return { ...c, messages };
  const { [m.inReplyTo]: _replaced, ...segments } = c.segments;
  return { messages, segments };
}

/** Ignores a segment of a turn already answered and a repeated `(turnId, seq)` (D8). */
export function withSegment(c: Chat, s: Segment): Chat {
  if (answered(c, s.turnId) || c.segments[s.turnId]?.[s.seq] !== undefined) return c;
  const texts = [...(c.segments[s.turnId] ?? [])];
  texts[s.seq] = s.text;
  return { ...c, segments: { ...c.segments, [s.turnId]: texts } };
}

/** The growing reply to a visitor message: its segments joined, in `seq` order. */
export function pendingText(c: Chat, turnId: string): string | null {
  const texts = c.segments[turnId]?.filter((t) => t !== undefined);
  return texts?.length ? texts.join(' ') : null;
}

/** The latest visitor message still waiting for a stored reply, if any. */
export function awaitingTurn(c: Chat): string | null {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    if (m.author !== 'visitor') return null;
    if (!answered(c, m.id)) return m.id;
  }
  return null;
}

const HAN = /\p{Script=Han}/u;

/** WCAG 3.1.2 language of parts (FEAT-023): Chinese text is marked; the rest inherits the panel's. */
export function langOf(text: string): 'zh-Hans' | undefined {
  return HAN.test(text) ? 'zh-Hans' : undefined;
}

export interface Row {
  kind: 'disclosure' | 'notice' | 'message';
  key: string;
  text: string;
}

/** A stored message's rows in the log: the disclosure, the after-hours notice, then the bubble (ui-design.md). */
export function rowsOf(m: Message): Row[] {
  const rows: Row[] = [];
  if (m.disclosure)
    rows.push({ kind: 'disclosure', key: `${m.id}-disclosure`, text: m.disclosure });
  if (m.notice) rows.push({ kind: 'notice', key: `${m.id}-notice`, text: m.notice });
  rows.push({ kind: 'message', key: m.id, text: m.body });
  return rows;
}
