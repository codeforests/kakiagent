import {
  CHANNEL_OFFLINE_TEXT_MAX,
  type ChannelHealthReason,
  type ChannelItem,
  type ChannelOfflineBody,
  type ChannelOfflineMode,
  type ChannelsResponse,
} from '@kaki/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { relativeTime } from './coach.ts';

/** Helpers for SCR-APP-036 Channels and the degraded-channel banner (FEAT-034 ui-design). */

export const CHANNELS_KEY = ['channels'];
const REFETCH_MS = 60_000;

/** The channels list, refetched every 60 s and on focus so the banner follows health. */
export function useChannels({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => api.channels(),
    enabled,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Puts one answered item back into the cached list (never optimistic: only after the server answers). */
export function useChannelUpdate() {
  const queryClient = useQueryClient();
  return (item: ChannelItem) =>
    queryClient.setQueryData<ChannelsResponse>(CHANNELS_KEY, (old) =>
      old ? { ...old, channels: old.channels.map((c) => (c.id === item.id ? item : c)) } : old,
    );
}

export const HEALTH_REASON: Record<ChannelHealthReason, string> = {
  credential_revoked: 'The connection was removed or its access was revoked.',
  credential_invalid: 'The saved login for this channel no longer works.',
  unreachable: "We couldn't reach the service for the last 10 minutes.",
  send_rejected: 'The service refused our last message.',
};
export const FIX_LINE = "Reconnect it, or take it offline so visitors aren't left waiting.";

const WHEN = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Singapore',
});

/** "27 Oct 2026, 2:05 pm". */
export const formatWhen = (iso: string) =>
  WHEN.format(new Date(iso)).replace(/\b(AM|PM)\b/, (m) => m.toLowerCase());

export interface ChannelStatus {
  live: boolean;
  degraded: boolean;
  /** "Live since …", "Offline since …" or "Not live yet". */
  since: string;
  /** Only for health-checked channels: "Last checked 5 minutes ago" or "Not checked yet". */
  checked: string | null;
  /** The reason sentence while degraded. */
  reason: string | null;
}

export function channelStatus(item: ChannelItem, now = new Date()): ChannelStatus {
  const live = item.state === 'live';
  let since: string;
  if (!item.stateChangedAt) since = live ? 'Live' : 'Not live yet';
  else since = `${live ? 'Live' : 'Offline'} since ${formatWhen(item.stateChangedAt)}`;
  const degraded = item.health === 'degraded';
  return {
    live,
    degraded,
    since,
    checked: item.checksHealth
      ? item.healthCheckedAt
        ? `Last checked ${relativeTime(item.healthCheckedAt, now)}`
        : 'Not checked yet'
      : null,
    reason: degraded
      ? item.healthReason
        ? HEALTH_REASON[item.healthReason]
        : "This channel isn't working."
      : null,
  };
}

export interface OfflineDraft {
  mode: ChannelOfflineMode;
  en: string;
  zh: string;
}
export type OfflineErrors = Partial<Record<'mode' | 'en' | 'zh', string>>;

/** The form's values: the saved texts, or empty so the defaults show as placeholders. */
export const offlineDraftOf = (item: ChannelItem): OfflineDraft => ({
  mode: item.offline.mode,
  en: item.offline.message.en ?? '',
  zh: item.offline.message.zh ?? '',
});

export const sameOffline = (a: OfflineDraft, b: OfflineDraft) =>
  a.mode === b.mode && a.en.trim() === b.en.trim() && a.zh.trim() === b.zh.trim();

/** What visitors see: the typed text, or the default when it's empty. */
export const resolvedMessage = (d: OfflineDraft, item: ChannelItem) => ({
  en: d.en.trim() || item.offline.defaults.en,
  zh: d.zh.trim() || item.offline.defaults.zh,
});

/** Field errors in the ui-design copy; empty when the draft can be saved. */
export function validateOffline(d: OfflineDraft, item: ChannelItem): OfflineErrors {
  const errors: OfflineErrors = {};
  if (!item.offlineModes.includes(d.mode))
    errors.mode = `${item.name} can't hide. Choose "Show a message".`;
  for (const k of ['en', 'zh'] as const) {
    const n = d[k].trim().length;
    if (n > CHANNEL_OFFLINE_TEXT_MAX)
      errors[k] = `Keep the message under ${CHANNEL_OFFLINE_TEXT_MAX} characters (${n} now).`;
  }
  return errors;
}

export const offlineBodyOf = (d: OfflineDraft, version: number): ChannelOfflineBody => ({
  mode: d.mode,
  message: { en: d.en.trim() || null, zh: d.zh.trim() || null },
  version,
});

/** The go-offline dialog's clause, following the saved mode. */
export const offlineClause = (mode: ChannelOfflineMode) =>
  mode === 'message' ? 'see your message and contact details' : "don't see the chat button";

export const degradedChannels = (res: ChannelsResponse | undefined) =>
  res?.channels.filter((c) => c.health === 'degraded') ?? [];

/** The banner's sentence for one or more degraded channels; null for none. */
export function degradedBannerText(list: readonly ChannelItem[]): string | null {
  const [first] = list;
  if (!first) return null;
  if (list.length === 1) return `${first.name} isn't working. Visitors there may not get replies.`;
  return `${list.length} channels aren't working. Visitors there may not get replies.`;
}
