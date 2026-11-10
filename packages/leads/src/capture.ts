import type { LeadInput } from '@kaki/contracts';
import { addIdentity } from '@kaki/channels/contacts';
import { checkLead, leadOk } from '@kaki/contracts/lead-check';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import { appendSystemNotice, setConversationContact, type MessageRow } from '@kaki/inbox';
import { contactConsent, recordConsent, type ConsentInput } from './consent.js';
import { ConsentRequired, ConsentWithdrawn, LeadFieldsInvalid, NotCapturing } from './errors.js';
import { rescoreOnCapture, type Rescored } from './rescore.js';
import { leadCaptureConfig } from './settings.js';

const { consents, contacts } = schema;

/** The visitor's confirmation once their details reached the team (`lead_captured`; ui-design SCR-WGT-003). */
export function leadCapturedNotice(language: 'en' | 'zh', businessName: string): string {
  return language === 'zh'
    ? `谢谢，${businessName}已收到您的资料，会尽快联系您。`
    : `Thanks, ${businessName} has your details and will get back to you.`;
}

export interface CaptureInput {
  tenantId: string;
  conversationId: string | null;
  /** The granted enquiry consent the details are given under (AC-1). */
  consentId: string;
  /** Further consent rows of the same request (the contact form's marketing row). */
  consentIds?: readonly string[];
  input: LeadInput;
}

export interface Captured {
  status: 'created' | 'updated';
  leadId: string;
  contactId: string;
  /** The `lead_captured` notice, when there is a conversation. */
  notice: MessageRow | null;
  /** The score written at capture (FEAT-050 §5.2) and whether it alerted the team. */
  scoring: Rescored;
}

interface ContactRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The visitor's contact (LED-09; FEAT-039 D1, replacing FEAT-049 D4): the conversation's
 * contact, else the latest contact of the same browser (`visitor_id`, as `withdrawalTarget`),
 * else a new one. Typed details never match another contact: they become this contact's
 * unverified lead-form identities, and fill its display values when empty; a given name
 * replaces the old one. A per-browser lock serialises two submits from one visitor.
 */
async function contactForCapture(
  tx: Tx,
  tenantId: string,
  conversationId: string | null,
  v: { name: string; email: string; phone: string },
): Promise<string> {
  let found: ContactRow | null = null;
  if (conversationId) {
    const visitor = await tx.execute<{ visitor_id: string }>(
      sql`select visitor_id from conversations where tenant_id = ${tenantId} and id = ${conversationId}`,
    );
    const visitorId = visitor.rows[0]?.visitor_id;
    if (visitorId)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`capture:${tenantId}:${visitorId}`}, 0))`,
      );
    found =
      (
        await tx.execute<ContactRow>(sql`
          select k.id, k.name, k.email, k.phone from contacts k
          where k.tenant_id = ${tenantId} and k.merged_into is null and k.id = (
            select coalesce(c.contact_id, (
              select o.contact_id from conversations o
              where o.tenant_id = c.tenant_id and o.visitor_id = c.visitor_id
                and o.id <> c.id and o.contact_id is not null
              order by o.created_at desc limit 1))
            from conversations c where c.tenant_id = ${tenantId} and c.id = ${conversationId})
          for update of k`)
      ).rows[0] ?? null;
  }
  let contactId: string;
  if (found) {
    const set: Partial<{ name: string; email: string; phone: string }> = {};
    if (v.name && v.name !== found.name) set.name = v.name;
    if (v.email && !found.email) set.email = v.email;
    if (v.phone && !found.phone) set.phone = v.phone;
    if (Object.keys(set).length)
      await tx
        .update(contacts)
        .set({ ...set, updatedAt: sql`now()` })
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, found.id)));
    contactId = found.id;
  } else {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into contacts (tenant_id, name, email, phone)
          values (${tenantId}, ${v.name || null}, ${v.email || null}, ${v.phone || null})
          returning id`,
    );
    contactId = rows[0]!.id;
  }
  for (const [kind, value] of [
    ['email', v.email],
    ['phone', v.phone],
  ] as const)
    if (value)
      await addIdentity(tx, tenantId, contactId, {
        kind,
        value,
        source: 'lead_form',
        verified: false,
      });
  return contactId;
}

/**
 * `leads.captureLead` (UC-21 4–5; AC-1, AC-5, AC-6): checks the details against the business's
 * fields, resolves the contact, links the consent rows and the conversation to it, and creates
 * the contact's open lead or updates it (given fields overwrite, `captures` + 1). Writes nothing
 * unless a granted enquiry consent of this conversation (or this request) names it.
 */
export async function captureLead(tx: Tx, c: CaptureInput): Promise<Captured> {
  const config = await leadCaptureConfig(tx);
  if (!config) throw new NotCapturing('no purpose statement');
  const [consent] = await tx
    .select({
      id: consents.id,
      conversationId: consents.conversationId,
      at: consents.createdAt,
    })
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, c.tenantId),
        eq(consents.id, c.consentId),
        eq(consents.purpose, 'enquiry'),
        eq(consents.decision, 'agreed'),
      ),
    );
  if (!consent || consent.conversationId !== c.conversationId)
    throw new ConsentRequired('no granted consent');

  const check = checkLead(config.fields, c.input);
  if (!leadOk(check))
    throw new LeadFieldsInvalid({
      error: 'invalid_fields',
      fields: check.fields,
      needsContact: check.needsContact,
    });
  const v = check.value;
  const contactId = await contactForCapture(tx, c.tenantId, c.conversationId, v);
  // A consent given before the contact's latest withdrawal no longer counts (FEAT-051 AC-8);
  // the caller's transaction rolls back the contact update with the throw.
  const { withdrawnAt } = await contactConsent(tx, c.tenantId, contactId);
  if (withdrawnAt && consent.at.getTime() <= withdrawnAt.getTime())
    throw new ConsentWithdrawn('consent older than the withdrawal');

  const ids = [c.consentId, ...(c.consentIds ?? [])];
  await tx.execute(sql`
    update consents set contact_id = ${contactId}
    where tenant_id = ${c.tenantId} and contact_id is null
      and (decision = 'agreed' or purpose = 'marketing')
      and (id = any(${`{${ids.join(',')}}`}::uuid[])
        ${c.conversationId ? sql`or conversation_id = ${c.conversationId}` : sql``})`);
  if (c.conversationId) await setConversationContact(tx, c.tenantId, c.conversationId, contactId);

  const text = (s: string) => s || null;
  const { rows } = await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into leads (tenant_id, contact_id, consent_id, conversation_id, need, budget, preferred_time)
    values (${c.tenantId}, ${contactId}, ${c.consentId}, ${c.conversationId},
      ${text(v.need)}, ${text(v.budget)}, ${text(v.preferredTime)})
    on conflict (tenant_id, contact_id) where status in ('new', 'contacted') and superseded_by is null
    do update set
      need = coalesce(excluded.need, leads.need),
      budget = coalesce(excluded.budget, leads.budget),
      preferred_time = coalesce(excluded.preferred_time, leads.preferred_time),
      consent_id = excluded.consent_id,
      conversation_id = coalesce(excluded.conversation_id, leads.conversation_id),
      captures = leads.captures + 1,
      updated_at = now()
    returning id, (xmax = 0) as inserted`);
  const lead = rows[0]!;
  const status = lead.inserted ? 'created' : 'updated';
  await audit.append(tx, c.tenantId, {
    action: lead.inserted ? 'lead.created' : 'lead.updated',
    actorType: 'visitor',
    subjectType: c.conversationId ? 'conversation' : 'lead',
    subjectId: c.conversationId ?? lead.id,
    related: [
      { type: 'lead', id: lead.id },
      { type: 'contact', id: contactId },
    ],
    payload: {
      leadId: auditId(lead.id),
      contactId: auditId(contactId),
      consentId: auditId(c.consentId),
    },
  });
  const scoring = await rescoreOnCapture(tx, c.tenantId, lead.id);

  let notice: MessageRow | null = null;
  if (c.conversationId) {
    const [t] = await tx
      .execute<{ name: string }>(sql`select business_name as name from visitor_privacy()`)
      .then((r) => r.rows);
    notice = await appendSystemNotice(tx, {
      tenantId: c.tenantId,
      conversationId: c.conversationId,
      kind: 'lead_captured',
      text: (language) => leadCapturedNotice(language, t?.name ?? 'the team'),
    });
  }
  return { status, leadId: lead.id, contactId, notice, scoring };
}

/**
 * The fallback contact form (SCR-WGT-005; AC-9): consent and details in one request, one
 * transaction. The details are checked first, so a 422 records no consent either.
 */
export async function submitContactForm(
  tx: Tx,
  input: Omit<ConsentInput, 'agreed'> & { input: LeadInput },
): Promise<Captured> {
  const config = await leadCaptureConfig(tx);
  if (!config) throw new NotCapturing('no purpose statement');
  const check = checkLead(config.fields, input.input);
  if (!leadOk(check))
    throw new LeadFieldsInvalid({
      error: 'invalid_fields',
      fields: check.fields,
      needsContact: check.needsContact,
    });
  const recorded = await recordConsent(tx, { ...input, agreed: true });
  return captureLead(tx, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    consentId: recorded.consentId!,
    consentIds: recorded.marketingConsentId ? [recorded.marketingConsentId] : [],
    input: input.input,
  });
}
