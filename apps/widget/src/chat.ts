import type {
  LeadCaptureConfig,
  LeadPrefill,
  Message,
  MessageCard,
  TrackingMode,
  WidgetConfigResponse,
} from '@kaki/contracts';
import { formatSgd } from '@kaki/contracts/quote';
import {
  checkLead,
  leadOk,
  type LeadFieldError,
  type LeadFieldKey,
  type LeadValues,
} from '@kaki/contracts/lead-check';
import { mergeMessages } from './api.js';
import { pickLocale, type Locale, type Strings } from './strings.js';

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
  // The recap is the first message on the new channel (FEAT-038 §5.6): never in the widget.
  if (m.noticeKind === 'handoff_recap') return c;
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
  if (staffHandling(c)) return null;
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    if (m.author !== 'visitor') return null;
    if (!answered(c, m.id)) return m.id;
  }
  return null;
}

/**
 * A person handles the chat (FEAT-043 D8): the latest staff notice is "joined". The
 * assistant's typing indicator stays hidden until they leave.
 */
export function staffHandling(c: Chat): boolean {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const k = c.messages[i]!.noticeKind;
    if (k === 'staff_joined') return true;
    if (k === 'staff_left') return false;
  }
  return false;
}

/**
 * The visitor asked for a person and nobody has joined yet (FEAT-044 §5.7): the latest of
 * the escalated, staff joined/left and chat-ended notices is "escalated".
 */
export function escalationPending(c: Chat): boolean {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const k = c.messages[i]!.noticeKind;
    if (k === 'escalated') return true;
    if (k === 'staff_joined' || k === 'staff_left' || k === 'chat_ended') return false;
  }
  return false;
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
  /** A staff bubble's name line (FEAT-043): the display name, else "A team member". */
  name?: string;
}

/**
 * A stored message's rows in the log: the disclosure, the after-hours notice, then the
 * bubble (FEAT-023 ui-design.md); a chat-ended notice closes the chat, so it follows the
 * bubble (FEAT-025 ui-design.md). Staff joined/left notices have no body, so no bubble;
 * a staff bubble carries the person's name (FEAT-043 ui-design SCR-WGT-002).
 */
export function rowsOf(m: Message, teamMember = 'A team member'): Row[] {
  const rows: Row[] = [];
  if (m.disclosure)
    rows.push({ kind: 'disclosure', key: `${m.id}-disclosure`, text: m.disclosure });
  const notice: Row | null = m.notice
    ? { kind: 'notice', key: `${m.id}-notice`, text: m.notice }
    : null;
  if (notice && m.noticeKind !== 'chat_ended') rows.push(notice);
  if (m.body !== '' || !notice)
    rows.push(
      m.author === 'staff'
        ? { kind: 'message', key: m.id, text: m.body, name: m.authorName ?? teamMember }
        : { kind: 'message', key: m.id, text: m.body },
    );
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

export type MenuItem =
  'talkToPerson' | 'continueElsewhere' | 'privacy' | 'stopTracking' | 'shareTracking' | 'end';

/** The tracking prompt shows only in consent mode with no stored choice (FEAT-029 §5.8). */
export function trackingPromptShown(
  mode: TrackingMode,
  choice: 'accepted' | 'declined' | null,
): boolean {
  return mode === 'consent' && choice === null;
}

/**
 * The header menu's items, in order (SCR-WGT-002; FEAT-033 AC-5, AC-6). Talk to a person
 * hides while an escalation is pending or a person handles the chat (FEAT-044 AC-1).
 */
export function menuItems(
  config: Pick<WidgetConfigResponse, 'privacyNoticeUrl' | 'controls'> &
    Partial<Pick<WidgetConfigResponse, 'handoff'>>,
  s: {
    conversationId: string | null;
    ended: boolean;
    preview: boolean;
    handover?: boolean;
    /** Consent mode only (SCR-WGT-002, FEAT-029): stop or share by the stored choice. */
    tracking?: { mode: TrackingMode; choice: 'accepted' | 'declined' | null };
  },
): MenuItem[] {
  const items: MenuItem[] = [];
  if (config.controls.talkToPerson && !s.ended && !s.handover) items.push('talkToPerson');
  // Continue elsewhere (FEAT-038 §5.8): a live channel and a conversation to carry over.
  if (
    config.handoff &&
    handoffOptions(config.handoff).length > 0 &&
    s.conversationId &&
    !s.ended &&
    !s.preview
  )
    items.push('continueElsewhere');
  if (config.privacyNoticeUrl) items.push('privacy');
  if (s.tracking?.mode === 'consent' && !s.preview) {
    if (s.tracking.choice === 'accepted') items.push('stopTracking');
    else if (s.tracking.choice === 'declined') items.push('shareTracking');
  }
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

// ---- Consent and details (SCR-WGT-003, SCR-WGT-005; FEAT-049 §5.6) ------------------

/**
 * The message whose card is open: the latest card, unless the visitor wrote after it, the
 * details were captured, or the chat ended. Earlier cards show as answered or "Not answered".
 */
export function activeCard(c: Chat): string | null {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    // An approved quote (FEAT-055) is read-only: it doesn't open or answer a card.
    if (m.card && m.card.kind !== 'quote' && m.card.kind !== 'moved') return m.id;
    if (
      m.author === 'visitor' ||
      m.noticeKind === 'handoff_moved' ||
      m.noticeKind === 'lead_captured' ||
      m.noticeKind === 'consent_withdrawn' ||
      m.noticeKind === 'chat_ended'
    )
      return null;
  }
  return null;
}

/** A tenant text in the panel's locale; Chinese falls back to English when empty (ui-design). */
export function localText(text: { en: string; zh: string }, locale: Locale): string {
  return locale === 'zh-Hans' && text.zh.trim() ? text.zh : text.en;
}

export type LeadErrors = Partial<Record<LeadFieldKey, LeadFieldError>>;

export interface LeadFieldView {
  key: LeadFieldKey;
  label: string;
  required: boolean;
  kind: 'text' | 'tel' | 'email' | 'textarea';
  autocomplete: string | undefined;
  help: string | undefined;
}

const LABEL: Record<LeadFieldKey, keyof Strings> = {
  name: 'fieldName',
  phone: 'fieldPhone',
  email: 'fieldEmail',
  need: 'fieldNeed',
  budget: 'fieldBudget',
  preferredTime: 'fieldPreferredTime',
};
const KIND: Partial<Record<LeadFieldKey, LeadFieldView['kind']>> = {
  phone: 'tel',
  email: 'email',
  need: 'textarea',
};
const AUTOCOMPLETE: Partial<Record<LeadFieldKey, string>> = {
  name: 'name',
  phone: 'tel',
  email: 'email',
};

/**
 * The form's fields (SCR-WGT-003 form): the business's enabled fields in order, and whether
 * to say that phone or email is needed (both shown, both optional; D6).
 */
export function leadFormView(
  fields: LeadCaptureConfig['fields'],
  t: Strings,
): { fields: LeadFieldView[]; contactCaption: boolean } {
  const view = fields.map((f) => ({
    key: f.key,
    label: t[LABEL[f.key]] as string,
    required: f.mode === 'required',
    kind: KIND[f.key] ?? 'text',
    autocomplete: AUTOCOMPLETE[f.key],
    help: f.key === 'phone' ? t.phoneHelp : undefined,
  }));
  const optional = (k: LeadFieldKey) => view.find((f) => f.key === k)?.required === false;
  return { fields: view, contactCaption: optional('phone') && optional('email') };
}

/** The form's starting values: the prefill triage validated, only for fields shown. */
export function leadValues(
  fields: LeadCaptureConfig['fields'],
  prefill: LeadPrefill,
): Partial<Record<LeadFieldKey, string>> {
  const values: Partial<Record<LeadFieldKey, string>> = {};
  for (const f of fields)
    values[f.key] = (prefill as Record<string, string | undefined>)[f.key] ?? '';
  return values;
}

/** The client check before sending: the same rules as the server (`checkLead`, D7). */
export function validateLead(
  fields: LeadCaptureConfig['fields'],
  values: Partial<Record<LeadFieldKey, string>>,
): { errors: LeadErrors; needsContact: boolean; ok: boolean; value: LeadValues } {
  const c = checkLead(fields, values);
  return { errors: c.fields, needsContact: c.needsContact, ok: leadOk(c), value: c.value };
}

/** The text under a field in error (SCR-WGT-003 invalid). */
export function fieldErrorText(key: LeadFieldKey, code: LeadFieldError, t: Strings): string {
  if (key === 'phone' && code === 'invalid') return t.errPhone;
  if (key === 'email' && code === 'invalid') return t.errEmail;
  if (code === 'invalid') return t.errTooLong;
  return key === 'name'
    ? t.errName
    : key === 'phone'
      ? t.errPhone
      : key === 'email'
        ? t.errEmail
        : t.errRequired;
}

/** The collapsed summary of sent details: "Mei Ling · +65 9123 4567". */
export function sentSummary(value: LeadValues): string {
  const phone = value.phone ? phoneLabel(value.phone) : '';
  return [value.name, phone || value.email].filter(Boolean).join(' · ');
}

/** "2:31 pm" in the panel's locale. */
export function timeLabel(at: Date, locale: Locale): string {
  return at.toLocaleTimeString(locale === 'zh-Hans' ? 'zh-Hans-SG' : 'en-SG', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---- Consent withdrawal (SCR-WGT-003 withdrawn; FEAT-051 §5.6) -------------------------

/** The withdraw card's state: asked, or how it was answered. */
export type WithdrawState = 'asked' | 'all' | 'marketing' | 'nothing_held' | 'kept';
export type WithdrawChoice = 'all' | 'marketing' | 'keep';

/** The card's buttons in reading order: "Just stop offers" only when offers were agreed. */
export function withdrawChoices(offers: boolean): WithdrawChoice[] {
  return offers ? ['all', 'marketing', 'keep'] : ['all', 'keep'];
}

/**
 * The state a withdraw answer leads to: `already_withdrawn` collapses as withdrawn (with no
 * second notice), `nothing_held` says nothing is held.
 */
export function withdrawStateOf(
  scope: 'all' | 'marketing',
  status: 'withdrawn' | 'already_withdrawn' | 'nothing_held',
): WithdrawState {
  return status === 'nothing_held' ? 'nothing_held' : scope;
}

/** The collapsed card's one line; null while asked. */
export function withdrawLine(
  state: WithdrawState,
  t: Strings,
  business: string,
  time: string,
): string | null {
  switch (state) {
    case 'all':
      return t.withdrawnLine(time);
    case 'marketing':
      return t.offersStoppedLine(time);
    case 'nothing_held':
      return t.nothingHeldLine(business);
    case 'kept':
      return t.keptLine(business);
    default:
      return null;
  }
}

type QuoteCardData = Extract<MessageCard, { kind: 'quote' }>;

/** One row of the quote card (SCR-WGT-002; FEAT-055): amounts preformatted, never model text. */
export interface QuoteView {
  lines: { key: string; label: string; amount: string; each: string }[];
  discount: { label: string; amount: string } | null;
  total: string;
  gst: string | null;
  note: string | null;
}

/**
 * The quote card's rows from the card's values (D2): line amounts from quantity × unit price,
 * the discount and total from the stored totals, so the card always shows what was approved.
 */
export function quoteView(card: QuoteCardData, t: Strings): QuoteView {
  return {
    lines: card.lines.map((l, i) => ({
      key: `${i}`,
      label: `${l.quantity} × ${l.label}`,
      amount: formatSgd(l.quantity * l.unitPriceCents),
      each: t.quoteEach(formatSgd(l.unitPriceCents)),
    })),
    discount:
      card.discountPct > 0
        ? { label: t.quoteOff(card.discountPct), amount: formatSgd(-card.totals.discountCents) }
        : null,
    total: formatSgd(card.totals.totalCents),
    gst:
      card.totals.gst === 'inclusive'
        ? t.gstInclusive
        : card.totals.gst === 'exclusive'
          ? t.gstExclusive
          : null,
    note: card.note.trim() || null,
  };
}

// ---- Continue elsewhere (SCR-WGT-004, SCR-WGT-002 moved; FEAT-038 §5.8) ----------------------

export type HandoffChannel = 'telegram' | 'email';
export type HandoffFailure =
  | 'channel_unavailable'
  | 'conversation_closed'
  | 'invalid_email'
  | 'rate_limited'
  | 'moved'
  | 'failed';

/** The channels a card or the config offers, Telegram first (ui-design SCR-WGT-004). */
export function handoffOptions(
  flags: { telegram: boolean; email: boolean },
  removed: readonly HandoffChannel[] = [],
): HandoffChannel[] {
  const all: HandoffChannel[] = [];
  if (flags.telegram) all.push('telegram');
  if (flags.email) all.push('email');
  return all.filter((c) => !removed.includes(c));
}

/** The menu item's label: both channels, or only the live one's name. */
export function handoffMenuLabel(flags: { telegram: boolean; email: boolean }, t: Strings): string {
  const options = handoffOptions(flags);
  if (options.length === 2) return t.handoffMenu;
  return options[0] === 'telegram' ? t.handoffTelegram : t.handoffEmail;
}

/** The card's inline error (ui-design SCR-WGT-004 errors); `invalid_email` shows on the field. */
export function handoffErrorText(
  code: HandoffFailure,
  channel: HandoffChannel,
  t: Strings,
): string {
  if (code === 'channel_unavailable') return t.handoffUnavailable(channel === 'telegram');
  if (code === 'rate_limited') return t.handoffRateLimited;
  if (code === 'conversation_closed') return t.handoffClosed;
  if (code === 'invalid_email') return t.errEmail;
  return t.handoffFailed;
}

export interface MovedView {
  channel: HandoffChannel;
  /** The bot without a token (Telegram); null when not known. */
  url: string | null;
  /** The stored `handoff_moved` notice, or null when only a 409 told us. */
  noticeId: string | null;
}

/**
 * The moved state (SCR-WGT-002; FEAT-038 AC-8): from the stored `handoff_moved` notice's
 * card, else from a 409 `moved` (`fallback`); null while the chat is still here.
 */
export function movedView(c: Chat, fallback: HandoffChannel | null): MovedView | null {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!;
    if (m.noticeKind === 'handoff_moved' && m.card?.kind === 'moved')
      return { channel: m.card.channel, url: m.card.url, noticeId: m.id };
  }
  return fallback ? { channel: fallback, url: null, noticeId: null } : null;
}

/**
 * Splits `a **b** c` into text and bold parts (strings mark the word to tap), then fills
 * `{name}` placeholders, so a value with asterisks (a masked address) stays as it is.
 */
export function boldParts(
  text: string,
  vars: Record<string, string> = {},
): { text: string; bold: boolean }[] {
  return text
    .split('**')
    .map((part, i) => ({
      text: part.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all),
      bold: i % 2 === 1,
    }))
    .filter((p) => p.text !== '');
}
