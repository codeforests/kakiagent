import type { LeadInput } from '@kaki/contracts';
import { checkLead, leadOk } from '@kaki/contracts/lead-check';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import { appendSystemNotice, setConversationContact, type MessageRow } from '@kaki/inbox';
import { recordConsent, type ConsentInput } from './consent.js';
import { ConsentRequired, LeadFieldsInvalid, NotCapturing } from './errors.js';
import { leadCaptureConfig } from './settings.js';

const { consents, contacts } = schema;

/** The visitor's confirmation once their details reached the team (`lead_captured`). */
export function leadCapturedNotice(language: 'en' | 'zh', businessName: string): string {
  return language === 'zh'
    ? `谢谢！您的资料已发送给${businessName}，他们会尽快联系您。`
    : `Thanks! Your details have been sent to ${businessName}. They'll get back to you soon.`;
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
}

interface ContactRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

const lockBy = async (tx: Tx, tenantId: string, column: 'email' | 'phone', value: string) =>
  value
    ? ((
        await tx.execute<ContactRow>(
          sql`select id, name, email, phone from contacts
              where tenant_id = ${tenantId} and ${sql.identifier(column)} = ${value} for update`,
        )
      ).rows[0] ?? null)
    : null;

/**
 * The visitor's contact (LED-09, D4): the one with this email, else this phone, else the one
 * already on the conversation, else a new one. Empty fields are filled; a different name
 * replaces the old one; a phone or email another contact holds stays off this one. Rows are
 * locked so two submits from one person serialise; a lost insert race re-reads the winner.
 */
async function resolveContact(
  tx: Tx,
  tenantId: string,
  conversationId: string | null,
  v: { name: string; email: string; phone: string },
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let found =
      (await lockBy(tx, tenantId, 'email', v.email)) ??
      (await lockBy(tx, tenantId, 'phone', v.phone));
    if (!found && conversationId) {
      found =
        (
          await tx.execute<ContactRow>(
            sql`select k.id, k.name, k.email, k.phone from contacts k
                join conversations c on c.tenant_id = k.tenant_id and c.contact_id = k.id
                where c.tenant_id = ${tenantId} and c.id = ${conversationId} for update of k`,
          )
        ).rows[0] ?? null;
    }
    if (found) {
      const free = async (column: 'email' | 'phone', value: string) => {
        if (!value || found![column]) return false;
        const other = await lockBy(tx, tenantId, column, value);
        return !other;
      };
      const set: Partial<{ name: string; email: string; phone: string }> = {};
      if (v.name && v.name !== found.name) set.name = v.name;
      if (await free('email', v.email)) set.email = v.email;
      if (await free('phone', v.phone)) set.phone = v.phone;
      if (Object.keys(set).length)
        await tx
          .update(contacts)
          .set({ ...set, updatedAt: sql`now()` })
          .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, found.id)));
      return found.id;
    }
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into contacts (tenant_id, name, email, phone)
          values (${tenantId}, ${v.name || null}, ${v.email || null}, ${v.phone || null})
          on conflict do nothing returning id`,
    );
    if (rows[0]) return rows[0].id;
  }
  throw new Error('leads: contact not resolved');
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
    .select({ id: consents.id, conversationId: consents.conversationId })
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
  const contactId = await resolveContact(tx, c.tenantId, c.conversationId, v);

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
    on conflict (tenant_id, contact_id) where status in ('new', 'contacted') do update set
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
  return { status, leadId: lead.id, contactId, notice };
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
