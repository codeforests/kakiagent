import type { LeadPrefill } from '@kaki/contracts';
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
