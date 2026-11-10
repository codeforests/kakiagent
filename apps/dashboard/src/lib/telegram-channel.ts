import {
  type ChannelHealthReason,
  type TelegramAlertLink,
  type TelegramChannelResponse,
  TelegramToken,
} from '@kaki/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { CHANNELS_KEY } from './channels.ts';
import { relativeTime } from './coach.ts';
import { NOTIFICATIONS_KEY } from './notifications.ts';

/** Data and pure helpers for SCR-APP-039 Telegram (FEAT-037 ui-design). */

export const TELEGRAM_CHANNEL_KEY = ['telegram-channel'];
/** How often the page re-reads the member's link while it waits for Start (ui-design). */
export const LINK_POLL_MS = 3_000;

export function useTelegramChannel(enabled = true) {
  return useQuery({
    queryKey: TELEGRAM_CHANNEL_KEY,
    queryFn: () => api.telegramChannel(),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Stores a write's answer and refreshes Channels and the alert preferences (the bot adds a column). */
export function useTelegramUpdate() {
  const queryClient = useQueryClient();
  return (res: TelegramChannelResponse) => {
    queryClient.setQueryData(TELEGRAM_CHANNEL_KEY, res);
    void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };
}

const FORMAT_TEXT =
  "That doesn't look like a bot token. It's the line BotFather sent, like 123456789:AA…";

/** The token field's own check before sending: the contract's shape, or the format error. */
export function tokenError(text: string): string | null {
  if (!text.trim()) return 'Paste the token BotFather sent you.';
  return TelegramToken.safeParse(text).success ? null : FORMAT_TEXT;
}

/**
 * The inline error for a failed connect or replace (NFR-19). Null for `stale` and
 * `already_connected`, which show the reload alert instead.
 */
export function telegramErrorText(err: unknown): string | null {
  if (!(err instanceof ApiError)) return "We couldn't save. Check your connection and try again.";
  switch (err.code) {
    case 'invalid_format':
    case 'invalid_body':
      return FORMAT_TEXT;
    case 'token_rejected':
      return "Telegram didn't accept this token. Copy it again from BotFather, or send /token there for a new one.";
    case 'bot_in_use':
      return 'This bot is already connected to another business on KakiAgent. Create a new bot with /newbot.';
    case 'different_bot':
      return 'This token is for a different bot. Disconnect first to switch bots.';
    case 'provider_unavailable':
      return "We couldn't reach Telegram. Try again in a minute.";
    case 'stale':
    case 'already_connected':
    case 'not_connected':
      return null;
    default:
      return "We couldn't save. Try again.";
  }
}

/** Errors that mean the page is out of date: show "Someone else changed this" and Reload. */
export const needsReload = (err: unknown) =>
  err instanceof ApiError &&
  (err.code === 'stale' || err.code === 'already_connected' || err.code === 'not_connected');

export interface DegradedCopy {
  text: string;
  /** The alert's action: replace the token, or FEAT-034's check. */
  action: 'replace' | 'check';
}

/** The degraded alert by reason (ui-design "Degraded"); unknown reasons read as unreachable. */
export function degradedCopy(reason: ChannelHealthReason | null): DegradedCopy {
  if (reason === 'credential_revoked')
    return {
      text: "Telegram stopped accepting the bot token, so customers aren't getting replies. Get a new token with /token in @BotFather, then replace it here.",
      action: 'replace',
    };
  if (reason === 'credential_invalid')
    return {
      text: "Your bot is connected to another service, so its messages don't reach us. Disconnect it there, then check again.",
      action: 'check',
    };
  return { text: "We can't reach Telegram right now. We'll keep trying.", action: 'check' };
}

/** The status line under the bot: last message, or how to try it (offline: messages wait). */
export function lastReceivedText(
  data: Pick<TelegramChannelResponse, 'lastReceivedAt' | 'connection'>,
  now = new Date(),
): string {
  if (data.lastReceivedAt) return `Last message ${relativeTime(data.lastReceivedAt, now)}.`;
  if (data.connection?.state === 'live')
    return 'No messages yet. Send your bot a message to try it.';
  return 'No messages yet. Messages wait in your inbox until you go live.';
}

const IGNORED: Record<TelegramChannelResponse['ignored'][number]['reason'], [string, string]> = {
  group: ['group message', 'group messages'],
  unsupported: ['sticker, photo or voice message', 'stickers, photos or voice messages'],
  staff_chat: ["message from team members' alert chats", "messages from team members' alert chats"],
};
const IGNORED_ORDER = Object.keys(IGNORED) as (keyof typeof IGNORED)[];

/** The "Ignored in the last 7 days" lines, non-zero only, in the ui-design's order. */
export function ignoredLines(ignored: TelegramChannelResponse['ignored']): string[] {
  const counts = new Map(ignored.map((i) => [i.reason, i.count]));
  return IGNORED_ORDER.flatMap((k) => {
    const n = counts.get(k) ?? 0;
    if (!n) return [];
    const [one, many] = IGNORED[k];
    return [`${n} ${n === 1 ? one : many}`];
  });
}

/** "{n} people on your team get alerts here." */
export const alertMembersText = (n: number) =>
  n === 1 ? '1 person on your team gets alerts here.' : `${n} people on your team get alerts here.`;

/** What the alerts card shows: the server's state, with an expired start link read as not linked. */
export type LinkView =
  | { kind: 'not_linked'; expired: boolean }
  | { kind: 'pending'; url: string | null }
  | { kind: 'linked'; name: string | null; linkedAt: string | null };

export function linkView(
  link: TelegramAlertLink,
  started: { url: string; expiresAt: string } | null,
  now = new Date(),
): LinkView {
  if (link.state === 'linked') return { kind: 'linked', name: link.name, linkedAt: link.linkedAt };
  const expired = started !== null && new Date(started.expiresAt).getTime() <= now.getTime();
  if (expired) return { kind: 'not_linked', expired: true };
  if (started) return { kind: 'pending', url: started.url };
  if (link.state === 'pending') return { kind: 'pending', url: null };
  return { kind: 'not_linked', expired: false };
}

const DAY = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});

/** "Alerts go to Mei on Telegram since 9 Nov 2026." */
export function linkedText(name: string | null, linkedAt: string | null): string {
  const who = name ? `${name} on Telegram` : 'your Telegram';
  return linkedAt
    ? `Alerts go to ${who} since ${DAY.format(new Date(linkedAt))}.`
    : `Alerts go to ${who}.`;
}

/**
 * The Notifications page's line for Telegram (SCR-APP-056 partial): the help text, and whether
 * the Telegram switches can change.
 */
export function linkStateText(
  link: TelegramAlertLink,
  email: string,
): { help: string; enabled: boolean } {
  if (link.state === 'linked')
    return {
      help: `Alerts go to ${email} and to Telegram${link.name ? ` (${link.name})` : ''}.`,
      enabled: true,
    };
  if (link.state === 'pending')
    return { help: 'Waiting for you to press Start in Telegram.', enabled: false };
  return { help: 'Link your Telegram to turn these on.', enabled: false };
}
