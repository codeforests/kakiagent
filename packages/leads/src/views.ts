import type { ConsentDecision, ContactLead, LeadConsentRecord, LeadSummary } from '@kaki/contracts';
import { formatSgPhone } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { contactConsent } from './consent.js';
import {
  consentRecords,
  iso,
  latestConsentColumns,
  latestConsentJoins,
  marketingOf,
  scoringOf,
  type NamesOf,
} from './list.js';

export interface ContactView {
  contactId: string;
  name: string | null;
  email: string | null;
  /** Formatted `+65 9123 4567`. */
  phone: string | null;
  /** The Telegram `@username`, without the `@` (FEAT-037 §3). */
  telegramUsername: string | null;
  /** FEAT-039 §5.4: the shown email / Telegram account is a verified identity of this contact. */
  verified: { email: boolean; telegram: boolean };
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
    email_verified: boolean;
    telegram_verified: boolean;
  }>(sql`
    select k.id, k.name, k.email, k.phone, k.telegram_username,
      exists (select 1 from contact_identities i where i.tenant_id = k.tenant_id
        and i.contact_id = k.id and i.kind = 'email' and i.value = k.email
        and i.verified_at is not null) as email_verified,
      exists (select 1 from contact_identities i where i.tenant_id = k.tenant_id
        and i.contact_id = k.id and i.kind = 'telegram' and i.value = k.telegram_id::text
        and i.verified_at is not null) as telegram_verified
    from contacts k
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
        verified: { email: r.email_verified, telegram: r.telegram_verified },
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
    order by (l.status in ('new', 'contacted') and l.superseded_by is null) desc, l.updated_at desc
    limit 1`);
  const r = rows[0];
  if (!r) return null;
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

/**
 * A contact's leads and consent records for the Contact page (FEAT-039 §5.4): leads newest
 * first with `supersededBy` (D6), consents as on the lead page.
 */
export async function contactLeads(
  tx: Tx,
  tenantId: string,
  contactId: string,
  names?: NamesOf,
): Promise<{ leads: ContactLead[]; consents: LeadConsentRecord[] }> {
  const { rows } = await tx.execute<{
    id: string;
    status: ContactLead['status'];
    need: string | null;
    created_at: Date | string;
    superseded_by: string | null;
  }>(sql`
    select id, status, need, created_at, superseded_by from leads
    where tenant_id = ${tenantId} and contact_id = ${contactId}
    order by created_at desc, id`);
  return {
    leads: rows.map((r) => ({
      id: r.id,
      status: r.status,
      need: r.need,
      createdAt: iso(r.created_at),
      supersededBy: r.superseded_by,
    })),
    consents: await consentRecords(tx, tenantId, contactId, names),
  };
}

export interface ContactLeadSummary {
  /** The open lead that counts (not superseded), if any. */
  openLead: { id: string; need: string | null } | null;
  /** The latest decision per purpose (FEAT-051's rule; D8). */
  consent: { enquiry: ConsentDecision | null; marketing: ConsentDecision | null };
  /** The latest consent row per purpose, for combining two contacts in a merge preview. */
  latest: { enquiry: Date | null; marketing: Date | null };
}

/** One side of a merge preview (FEAT-039 §5.4): the open lead and the consent state. */
export async function contactLeadSummary(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<ContactLeadSummary> {
  const { rows } = await tx.execute<{ id: string; need: string | null }>(sql`
    select id, need from leads
    where tenant_id = ${tenantId} and contact_id = ${contactId}
      and status in ('new', 'contacted') and superseded_by is null`);
  const state = await contactConsent(tx, tenantId, contactId);
  return {
    openLead: rows[0] ? { id: rows[0].id, need: rows[0].need } : null,
    consent: {
      enquiry: state.enquiry?.decision ?? null,
      marketing: state.marketing?.decision ?? null,
    },
    latest: { enquiry: state.enquiry?.at ?? null, marketing: state.marketing?.at ?? null },
  };
}
