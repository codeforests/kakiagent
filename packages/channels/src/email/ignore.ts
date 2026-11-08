/**
 * Which inbound emails never get an AI reply or a conversation (CHN-10; FEAT-036 §5.1).
 * Pure: the caller says whether the Message-ID is one of our own replies. First match wins.
 */
import type { EmailIgnoreReason } from '@kaki/contracts';
import type { ParsedEmail } from './parse.js';

/** SES receipt verdicts from the SNS notification (`receipt.spamVerdict` etc.). */
export interface SesVerdicts {
  spam?: string | undefined;
  virus?: string | undefined;
  dmarc?: string | undefined;
}

export interface IgnoreContext {
  /** The Message-ID is one of ours (an `out` row in `email_messages`). */
  ownMessage: boolean;
  /** Our forwarding and reply-from addresses, lower case. */
  ownAddresses: readonly string[];
  verdicts?: SesVerdicts | undefined;
}

const AUTO_SUBJECT = /^(automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|自动回复)/i;
const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i;

export function ignoreReason(p: ParsedEmail, ctx: IgnoreContext): EmailIgnoreReason | null {
  const h = (name: string) => p.headers.get(name)?.toLowerCase();
  if (ctx.ownMessage || (p.from && ctx.ownAddresses.includes(p.from.address))) return 'echo';
  const returnPath = h('return-path');
  if (
    returnPath === '<>' ||
    returnPath === '' ||
    (p.from && BOUNCE_FROM.test(p.from.address)) ||
    p.contentType === 'multipart/report'
  )
    return 'bounce';
  const auto = h('auto-submitted');
  const suppress = h('x-auto-response-suppress') ?? '';
  if (
    (auto !== undefined && auto !== 'no') ||
    p.headers.has('x-autoreply') ||
    p.headers.has('x-autorespond') ||
    /\b(oof|all)\b/.test(suppress) ||
    h('precedence') === 'auto_reply' ||
    AUTO_SUBJECT.test(p.subject)
  )
    return 'auto_reply';
  if (p.headers.has('list-id') || p.headers.has('list-unsubscribe') || p.headers.has('list-post'))
    return 'list';
  const precedence = h('precedence');
  if (
    (precedence && ['bulk', 'junk', 'list'].includes(precedence)) ||
    p.headers.has('x-mc-user') ||
    p.headers.has('x-campaign') ||
    p.headers.has('x-campaignid') ||
    p.headers.has('feedback-id')
  )
    return 'bulk';
  const v = ctx.verdicts ?? {};
  if (v.spam?.toUpperCase() === 'FAIL' || v.dmarc?.toUpperCase() === 'FAIL') return 'spam';
  if (v.virus?.toUpperCase() === 'FAIL') return 'unsafe';
  return null;
}
