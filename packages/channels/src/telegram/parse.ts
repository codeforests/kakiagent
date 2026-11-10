/**
 * A Telegram `Update` → the canonical `InboundEvent` (FEAT-037 §5.1). Pure. Only the fields
 * the channel uses are read; everything Telegram-specific rides in `extensions.telegram`.
 */
import { z } from 'zod';
import type { InboundEvent } from '../adapter.js';

export const TEXT_MAX = 4000;

const User = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
const Chat = z.object({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
});
const Message = z.looseObject({
  message_id: z.number().int(),
  from: User.optional(),
  chat: Chat,
  date: z.number().int(),
  text: z.string().optional(),
  caption: z.string().optional(),
});
const MemberUpdate = z.object({
  chat: Chat,
  from: User,
  date: z.number().int(),
  new_chat_member: z.object({ status: z.string() }),
});
export const TelegramUpdate = z.looseObject({
  update_id: z.number().int(),
  message: Message.optional(),
  my_chat_member: MemberUpdate.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdate>;

/** A message with no text: what staff see instead (D11). */
export const CONTENT_LABELS: Record<string, string> = {
  sticker: '[Sticker]',
  voice: '[Voice message]',
  video_note: '[Video message]',
  animation: '[GIF]',
  photo: '[Photo]',
  video: '[Video]',
  audio: '[Audio]',
  document: '[File]',
  location: '[Location]',
  venue: '[Location]',
  contact: '[Contact]',
  poll: '[Poll]',
  dice: '[Dice]',
};
export const OTHER_CONTENT = '[Message]';

export interface TelegramExtensions {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  updateId: number;
  messageId: number | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  /** `/start`, `/stop`, … without `@botname`, lower case; null for plain text. */
  command: string | null;
  /** What follows `/start ` (a deep-link code), else null. */
  startPayload: string | null;
  /** `my_chat_member`: the bot's new status in that chat (`member`, `kicked`, `left`, …). */
  memberStatus: string | null;
  /** The placeholder of a message without text or caption, else null. */
  contentLabel: string | null;
}

export function telegramOf(e: InboundEvent): TelegramExtensions {
  return e.extensions.telegram as TelegramExtensions;
}

const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 3)}[…]` : s);

function contentLabel(m: Record<string, unknown>): string {
  for (const [field, label] of Object.entries(CONTENT_LABELS)) if (m[field]) return label;
  return OTHER_CONTENT;
}

function command(text: string | undefined): { command: string | null; payload: string | null } {
  const m = text?.match(/^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return { command: null, payload: null };
  const payload = m[2]?.trim() || null;
  return { command: m[1]!.toLowerCase(), payload };
}

/**
 * One update → at most one event: a message (`kind: 'message'`) or a change of the bot's
 * membership in a chat (`kind: 'postback'`, text null). Anything else → null.
 */
export function normaliseUpdate(
  raw: unknown,
  ids: { tenantId: string; connectionId: string },
): InboundEvent | null {
  const parsed = TelegramUpdate.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data;
  if (u.message) {
    const m = u.message;
    const body = m.text ?? m.caption;
    const cmd = m.text ? command(m.text) : { command: null, payload: null };
    const from = m.from;
    const ext: TelegramExtensions = {
      chatId: m.chat.id,
      chatType: m.chat.type,
      updateId: u.update_id,
      messageId: m.message_id,
      username: from?.username ?? null,
      firstName: from?.first_name ?? null,
      lastName: from?.last_name ?? null,
      command: cmd.command,
      startPayload: cmd.command === 'start' ? cmd.payload : null,
      memberStatus: null,
      contentLabel: body ? null : contentLabel(m),
    };
    return {
      kind: 'message',
      ...ids,
      externalUserId: String(from?.id ?? m.chat.id),
      text: body ? clip(body) : null,
      attachments: [],
      localeHint: from?.language_code ?? null,
      timestamp: new Date(m.date * 1000),
      extensions: { telegram: ext },
    };
  }
  if (u.my_chat_member) {
    const c = u.my_chat_member;
    const ext: TelegramExtensions = {
      chatId: c.chat.id,
      chatType: c.chat.type,
      updateId: u.update_id,
      messageId: null,
      username: c.from.username ?? null,
      firstName: c.from.first_name ?? null,
      lastName: c.from.last_name ?? null,
      command: null,
      startPayload: null,
      memberStatus: c.new_chat_member.status,
      contentLabel: null,
    };
    return {
      kind: 'postback',
      ...ids,
      externalUserId: String(c.from.id),
      text: null,
      attachments: [],
      localeHint: c.from.language_code ?? null,
      timestamp: new Date(c.date * 1000),
      extensions: { telegram: ext },
    };
  }
  return null;
}

/** The customer's display name: first + last, ≤ 120 (the contacts check). */
export function displayName(t: TelegramExtensions): string | null {
  const n = [t.firstName, t.lastName].filter(Boolean).join(' ').trim();
  return n ? n.slice(0, 120) : null;
}
