import type { LeadSummary } from '@kaki/contracts';
import { formatSgPhone } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { latestConsentColumns, latestConsentJoins, marketingOf, scoringOf } from './list.js';

export interface ContactView {
  contactId: string;
  name: string | null;
  email: string | null;
  /** Formatted `+65 9123 4567`. */
  phone: string | null;
  /** The Telegram `@username`, without the `@` (FEAT-037 §3). */
  telegramUsername: string | null;
}

/** The conversation's contact for the inbox sidebar (FEAT-049 §5.4), or null before any capture. */
export async function contactOf(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ContactView | null> {
  const { rows } = await tx.execute<{
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    telegram_username: string | null;
  }>(sql`
    select k.id, k.name, k.email, k.phone, k.telegram_username from contacts k
    join conversations c on c.tenant_id = k.tenant_id and c.contact_id = k.id
    where c.tenant_id = ${tenantId} and c.id = ${conversationId}`);
  const r = rows[0];
  return r
    ? {
        contactId: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone ? formatSgPhone(r.phone) : null,
        telegramUsername: r.telegram_username,
      }
    : null;
}

/**
 * The conversation's contact's lead for the sidebar: the open one, else the latest, with the
 * enquiry consent it was captured under and the contact's latest marketing answer.
 */
export async function leadSummaryOf(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<LeadSummary | null> {
  const { rows } = await tx.execute<{
    id: string;
    status: LeadSummary['status'];
    updated_at: Date | string;
    enquiry_at: Date | string;
    marketing_agreed: boolean | null;
    marketing_at: Date | string | null;
    marketing_withdrawn: boolean | null;
    consent_withdrawn_at: Date | string | null;
    score: 'hot' | 'warm' | 'cold' | null;
    score_points: number | null;
    score_reasons: NonNullable<LeadSummary['scoring']>['reasons'] | null;
    scored_at: Date | string | null;
  }>(sql`
    select l.id, l.status, l.updated_at, e.created_at as enquiry_at,
      l.score, l.score_points, l.score_reasons, l.scored_at, ${latestConsentColumns}
    from conversations c
    join leads l on l.tenant_id = c.tenant_id and l.contact_id = c.contact_id
    join consents e on e.tenant_id = l.tenant_id and e.id = l.consent_id
    ${latestConsentJoins}
    where c.tenant_id = ${tenantId} and c.id = ${conversationId}
    order by (l.status in ('new', 'contacted')) desc, l.updated_at desc
    limit 1`);
  const r = rows[0];
  if (!r) return null;
  const iso = (d: Date | string) => new Date(d).toISOString();
  return {
    id: r.id,
    status: r.status,
    updatedAt: iso(r.updated_at),
    consent: {
      enquiryAt: iso(r.enquiry_at),
      marketing: marketingOf(r),
      withdrawnAt: r.consent_withdrawn_at !== null ? iso(r.consent_withdrawn_at) : null,
    },
    scoring: scoringOf(r),
  };
}
