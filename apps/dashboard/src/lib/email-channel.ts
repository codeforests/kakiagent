import type {
  EmailChannelResponse,
  EmailDomainRecord,
  EmailDomainState,
  EmailIgnoreReason,
} from '@kaki/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { CHANNELS_KEY, formatWhen } from './channels.ts';
import { relativeTime } from './coach.ts';

/** Data and pure helpers for SCR-APP-038 Email channel (FEAT-036 ui-design). */

export const EMAIL_CHANNEL_KEY = ['email-channel'];
export const REPLY_CAP_MIN = 1;
export const REPLY_CAP_MAX = 50;

export function useEmailChannel() {
  return useQuery({
    queryKey: EMAIL_CHANNEL_KEY,
    queryFn: () => api.emailChannel(),
    // Forwarding status and the Gmail code arrive while the Owner is setting up.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Stores a write's answer and refreshes Channels (setup adds the email card there). */
export function useEmailUpdate() {
  const queryClient = useQueryClient();
  return (res: EmailChannelResponse) => {
    queryClient.setQueryData(EMAIL_CHANNEL_KEY, res);
    void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
  };
}

/** The reply cap field's error, or null when the text is a whole number from 1 to 50. */
export function replyCapError(text: string): string | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return 'Enter a number from 1 to 50.';
  const n = Number(t);
  return n >= REPLY_CAP_MIN && n <= REPLY_CAP_MAX ? null : 'Enter a number from 1 to 50.';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The domain of a typed address ("hello@Kaki.sg" → "kaki.sg"); empty when there's none. */
export const domainOf = (address: string) => address.trim().split('@')[1]?.toLowerCase() ?? '';

/** The address field's own check before sending. */
export const addressError = (address: string): string | null =>
  EMAIL_RE.test(address.trim()) ? null : 'Enter an email address like hello@yourbusiness.sg.';

/** The inline error for a failed domain write (NFR-19); null for `stale` (the reload alert). */
export function domainErrorText(err: unknown, address: string): string | null {
  if (!(err instanceof ApiError)) return "We couldn't save. Check your connection and try again.";
  switch (err.code) {
    case 'platform_domain':
      return `Use an address on your own domain, not ${domainOf(address) || 'a free email service'}.`;
    case 'invalid_body':
      return 'Enter an email address like hello@yourbusiness.sg.';
    case 'provider_unavailable':
      return "We couldn't reach our email provider. Try again in a minute.";
    case 'stale':
      return null;
    default:
      return "We couldn't save. Try again.";
  }
}

export const isStale = (err: unknown) => err instanceof ApiError && err.code === 'stale';

export interface Chip {
  tone: 'success' | 'neutral' | 'danger' | 'warning';
  icon: 'check' | 'clock' | 'x' | 'alert';
  text: string;
}

/** The record status chip: text and icon always. */
export function recordStatusText(status: EmailDomainRecord['status']): Chip {
  if (status === 'ok') return { tone: 'success', icon: 'check', text: 'OK' };
  if (status === 'failing') return { tone: 'danger', icon: 'x', text: 'Not found' };
  return { tone: 'neutral', icon: 'clock', text: 'Waiting' };
}

export function domainStateChip(state: EmailDomainState): Chip {
  if (state === 'verified') return { tone: 'success', icon: 'check', text: 'Verified' };
  if (state === 'failing') return { tone: 'warning', icon: 'alert', text: 'Not working' };
  return { tone: 'neutral', icon: 'clock', text: 'Checking DNS' };
}

export const RECORD_PURPOSE: Record<EmailDomainRecord['purpose'], string> = {
  dkim: 'Signs your email (DKIM)',
  mail_from_mx: 'Bounce handling (SPF)',
  mail_from_spf: 'Bounce handling (SPF)',
  dmarc: 'Sender policy (DMARC)',
};

type Domain = NonNullable<EmailChannelResponse['domain']>;

/** "Last checked 5 minutes ago", "Verified 27 Oct 2026, 2:05 pm" or "Not working since …". */
export function domainMeta(d: Domain, now = new Date()): string {
  if (d.state === 'verified' && d.verifiedAt) return `Verified ${formatWhen(d.verifiedAt)}`;
  if (d.state === 'failing' && d.failingSince)
    return `Not working since ${formatWhen(d.failingSince)}`;
  return d.checkedAt ? `Last checked ${relativeTime(d.checkedAt, now)}` : 'Not checked yet';
}

const IGNORED: Record<Exclude<EmailIgnoreReason, 'echo'>, [string, string]> = {
  auto_reply: ['out-of-office reply', 'out-of-office replies'],
  bounce: ['bounce', 'bounces'],
  list: ['mailing-list email', 'mailing-list emails'],
  bulk: ['bulk email', 'bulk emails'],
  spam: ['spam', 'spam'],
  unsafe: ['unsafe email', 'unsafe emails'],
  loop: ['loop', 'loops'],
};
const IGNORED_ORDER = Object.keys(IGNORED) as (keyof typeof IGNORED)[];

/**
 * The "Ignored in the last 7 days" lines, non-zero only, in the ui-design's order. An `echo`
 * (one of our own replies forwarded back) counts as a loop: to the Owner it is one.
 */
export function ignoredLines(ignored: EmailChannelResponse['ignored']): string[] {
  const counts = new Map<keyof typeof IGNORED, number>();
  for (const { reason, count } of ignored) {
    const key = reason === 'echo' ? 'loop' : reason;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return IGNORED_ORDER.flatMap((k) => {
    const n = counts.get(k) ?? 0;
    if (!n) return [];
    const [one, many] = IGNORED[k];
    return [`${n} ${n === 1 ? one : many}`];
  });
}

/** The DMARC row shows only while it's missing; the rest always. */
export const shownRecords = (records: readonly EmailDomainRecord[]) =>
  records.filter((r) => r.purpose !== 'dmarc' || r.status !== 'ok');
