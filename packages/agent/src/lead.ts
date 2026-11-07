import type { LeadPrefill, MessageCard } from '@kaki/contracts';
import { isEmail, normaliseSgPhone } from '@kaki/contracts/lead-check';
import { z } from 'zod';

/**
 * `capture_lead`'s args (AGT-06, LED-01; FEAT-049 §5.3, D1). The model's args are a proposal:
 * they only prefill the form for the visitor to confirm, and only what passes the same checks
 * as the form. The lead is stored by the widget's form submit, never by the turn.
 */
export const CaptureLeadArgs = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});
export type CaptureLeadArgs = z.infer<typeof CaptureLeadArgs>;

/** The valid args only: an invalid phone or email is dropped, never shown (AC-5). */
export function prefillOf(args: unknown): LeadPrefill {
  const parsed = CaptureLeadArgs.safeParse(args);
  if (!parsed.success) return {};
  const out: LeadPrefill = {};
  const name = parsed.data.name?.trim();
  if (name && name.length <= 120) out.name = name;
  const phone = parsed.data.phone ? normaliseSgPhone(parsed.data.phone) : null;
  if (phone) out.phone = phone;
  const email = parsed.data.email?.trim();
  if (email && isEmail(email)) out.email = email.toLowerCase();
  return out;
}

/** The conversation's lead-capture state the offer rule reads (leads `consentState`). */
export interface LeadState {
  enquiry: 'agreed' | 'declined' | 'withdrawn' | null;
  offered: boolean;
  captured: boolean;
  /** FEAT-051: the conversation's contact withdrew consent: no consent offer. */
  withdrawn?: boolean;
}

/**
 * The consent card for a `capture_lead` the dispatcher refused for want of consent (§5.3):
 * prefilled with the task's valid args only. Null when no such refusal.
 */
export function consentCardFor(
  reports: readonly { task: string; index: number; outcome: string; reason?: string }[],
  tasks: readonly { args?: unknown }[],
): MessageCard | null {
  const refused = reports.find(
    (r) => r.task === 'capture_lead' && r.outcome === 'refused' && r.reason === 'consent',
  );
  return refused ? { kind: 'consent', prefill: prefillOf(tasks[refused.index]?.args) } : null;
}

/** Replies the AI couldn't help with (UC-21 1, AGT-04, AGT-09, NFR-04). */
const OFFER_OUTCOMES = new Set(['unavailable', 'unsure', 'out_of_scope']);
/** Never a card: paused, not live, a safety turn, a reply the gate stopped. */
const NO_CARD_OUTCOMES = new Set(['paused', 'not_live', 'ended', 'gate_closed']);

/**
 * The card stored under a reply (§5.3; AC-7, AC-8): none without a saved purpose statement
 * (`capturing`, LED-02 fail closed) or on a safety, paused or not-live reply; the dispatch's
 * own card if any; else one consent offer per conversation on a reply the AI couldn't help
 * with, after hours, or escalated after hours, unless the visitor already answered, was
 * offered, or left their details.
 */
export function cardForReply(input: {
  card: MessageCard | null;
  outcome: string;
  safety: boolean;
  capturing: boolean;
  afterHoursNotice: boolean;
  escalatedAfterHours: boolean;
  state: LeadState | null;
}): MessageCard | null {
  if (input.safety || NO_CARD_OUTCOMES.has(input.outcome)) return null;
  // FEAT-051: a withdrawal never needs a purpose statement; consent and lead cards do.
  if (input.card?.kind === 'withdraw') return input.card;
  if (!input.capturing) return null;
  if (input.card) return input.card;
  const offerable =
    OFFER_OUTCOMES.has(input.outcome) ||
    input.afterHoursNotice ||
    (input.outcome === 'escalated' && input.escalatedAfterHours);
  const s = input.state;
  return offerable && s && !s.enquiry && !s.offered && !s.captured && !s.withdrawn
    ? { kind: 'consent', prefill: {} }
    : null;
}
