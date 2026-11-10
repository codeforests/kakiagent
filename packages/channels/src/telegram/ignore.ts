/**
 * CHN-05's ignore rules (FEAT-037 §5.1, D2, D11). Pure. Groups, supergroups and channels are
 * never answered (and being added to one is a group event); a private message with no text or
 * caption is `unsupported`. Edited messages never arrive (`allowed_updates`).
 */
import type { InboundEvent } from '../adapter.js';
import { telegramOf } from './parse.js';

export type TelegramIgnore = 'group' | 'unsupported';

/** Statuses meaning the bot is in a group (added, promoted). */
const IN_CHAT = new Set(['member', 'administrator', 'creator', 'restricted']);

export function telegramIgnoreReason(e: InboundEvent): TelegramIgnore | null {
  const t = telegramOf(e);
  if (t.chatType !== 'private') {
    if (e.kind === 'postback')
      return t.memberStatus && IN_CHAT.has(t.memberStatus) ? 'group' : null;
    return 'group';
  }
  if (e.kind === 'message' && e.text === null) return 'unsupported';
  return null;
}

/** A private `my_chat_member`: the customer blocked (`kicked`) or unblocked (`member`) the bot. */
export function blockChange(e: InboundEvent): 'blocked' | 'unblocked' | null {
  const t = telegramOf(e);
  if (e.kind !== 'postback' || t.chatType !== 'private') return null;
  if (t.memberStatus === 'kicked') return 'blocked';
  if (t.memberStatus === 'member') return 'unblocked';
  return null;
}
