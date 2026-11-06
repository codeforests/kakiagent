import type { LeadSummary } from '@kaki/contracts';
import { formatSgPhone } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';

export interface ContactView {
  contactId: string;
  name: string | null;
  email: string | null;
  /** Formatted `+65 9123 4567`. */
  phone: string | null;
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
  }>(sql`
    select k.id, k.name, k.email, k.phone from contacts k
    join conversations c on c.tenant_id = k.tenant_id and c.contact_id = k.id
    where c.tenant_id = ${tenantId} and c.id = ${conversationId}`);
  const r = rows[0];
  return r
    ? {
        contactId: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone ? formatSgPhone(r.phone) : null,
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
  }>(sql`
    select l.id, l.status, l.updated_at, e.created_at as enquiry_at,
      m.decision = 'agreed' as marketing_agreed, m.created_at as marketing_at
    from conversations c
    join leads l on l.tenant_id = c.tenant_id and l.contact_id = c.contact_id
    join consents e on e.tenant_id = l.tenant_id and e.id = l.consent_id
    left join lateral (
      select decision, created_at from consents
      where tenant_id = l.tenant_id and contact_id = l.contact_id and purpose = 'marketing'
      order by created_at desc limit 1
    ) m on true
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
      marketing:
        r.marketing_at !== null ? { agreed: !!r.marketing_agreed, at: iso(r.marketing_at) } : null,
    },
    scoring: null,
  };
}
