import type { Message, WidgetConfigResponse } from '@kaki/contracts';
import { mergeMessages } from './api.js';
import { pickLocale, type Locale } from './strings.js';

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

/** The tenant's greeting for the empty chat in the panel's locale (FEAT-024; SCR-WGT-002 greeting). */
export function greetingFor(
  greeting: { en: string; zh: string },
  locale: 'en' | 'zh-Hans',
): string {
  return locale === 'zh-Hans' ? greeting.zh : greeting.en;
}

export interface Row {
  kind: 'disclosure' | 'notice' | 'message';
  key: string;
  text: string;
}

/**
 * A stored message's rows in the log: the disclosure, the after-hours notice, then the
 * bubble (FEAT-023 ui-design.md); a chat-ended notice closes the chat, so it follows the
 * bubble (FEAT-025 ui-design.md).
 */
export function rowsOf(m: Message): Row[] {
  const rows: Row[] = [];
  if (m.disclosure)
    rows.push({ kind: 'disclosure', key: `${m.id}-disclosure`, text: m.disclosure });
  const notice: Row | null = m.notice
    ? { kind: 'notice', key: `${m.id}-notice`, text: m.notice }
    : null;
  if (notice && m.noticeKind !== 'chat_ended') rows.push(notice);
  rows.push({ kind: 'message', key: m.id, text: m.body });
  if (notice && m.noticeKind === 'chat_ended') rows.push(notice);
  return rows;
}

/** The AI ended the chat (AGT-13 repeated abuse): the composer closes (FEAT-025). */
export function chatEnded(c: Chat): boolean {
  return c.messages.some((m) => m.noticeKind === 'chat_ended');
}

/**
 * The chrome's locale (FEAT-033 D3, AC-7): the language of the latest agent or system
 * reply that has one, else the browser's.
 */
export function chromeLocale(c: Chat, navLang: string | undefined): Locale {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    if ((m.author === 'agent' || m.author === 'system') && m.language)
      return m.language === 'zh' ? 'zh-Hans' : 'en';
  }
  return pickLocale(navLang);
}

export type MenuItem = 'talkToPerson' | 'privacy' | 'end';

/** The header menu's items, in order (SCR-WGT-002; FEAT-033 AC-5, AC-6). */
export function menuItems(
  config: Pick<WidgetConfigResponse, 'privacyNoticeUrl' | 'controls'>,
  s: { conversationId: string | null; ended: boolean; preview: boolean },
): MenuItem[] {
  const items: MenuItem[] = [];
  if (config.controls.talkToPerson && !s.ended) items.push('talkToPerson');
  if (config.privacyNoticeUrl) items.push('privacy');
  if (s.conversationId && !s.ended && !s.preview) items.push('end');
  return items;
}

export interface NotLiveView {
  locale: Locale;
  text: string;
  email: { label: string; href: string } | null;
  phone: { label: string; href: string } | null;
}

/** `+6561234567` → `+65 6123 4567`; anything else as stored. */
const phoneLabel = (p: string) =>
  /^\+65\d{8}$/.test(p) ? `+65 ${p.slice(3, 7)} ${p.slice(7)}` : p;

/**
 * The not-live view (SCR-WGT-005, FEAT-034): the message in the browser's language and a
 * link for each contact the business has; null while live, or when hidden (never mounted).
 */
export function notLiveView(
  availability: WidgetConfigResponse['availability'],
  navLang: string | undefined,
): NotLiveView | null {
  if (availability.live || availability.mode !== 'message') return null;
  return noticeView(availability, navLang);
}

/**
 * The paused notice (SCR-WGT-005 paused, FEAT-057): the tenant's fallback and contacts,
 * same language rule as the not-live view; null while the AI runs, and while the widget
 * isn't live, where the not-live view wins (D7).
 */
export function pausedNotice(
  config: Pick<WidgetConfigResponse, 'availability' | 'aiPaused'>,
  navLang: string | undefined,
): NotLiveView | null {
  if (!config.aiPaused || !config.availability.live) return null;
  return noticeView(config.aiPaused, navLang);
}

function noticeView(
  notice: {
    message: { en: string; zh: string };
    contact: { email: string | null; phone: string | null };
  },
  navLang: string | undefined,
): NotLiveView {
  const locale = pickLocale(navLang);
  const { email, phone } = notice.contact;
  return {
    locale,
    text: locale === 'zh-Hans' ? notice.message.zh : notice.message.en,
    email: email ? { label: email, href: `mailto:${email}` } : null,
    phone: phone ? { label: phoneLabel(phone), href: `tel:${phone.replace(/[^+\d]/g, '')}` } : null,
  };
}
