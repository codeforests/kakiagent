import type { LeadCaptureConfig } from '@kaki/contracts';
import { and, desc, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { NotCapturing, WordingChanged } from './errors.js';
import { leadCaptureConfig } from './settings.js';

const { consents } = schema;

export interface ConsentInput {
  tenantId: string;
  /** Null for the pre-live contact form (D9). */
  conversationId: string | null;
  purposeWordingId: string;
  agreed: boolean;
  /** Present iff the card showed the opt-in. */
  marketing?: { wordingId: string; agreed: boolean } | undefined;
}

export interface RecordedConsent {
  /** The enquiry consent, or null when declined. */
  consentId: string | null;
  /** The marketing row, when the opt-in was shown and the enquiry agreed. */
  marketingConsentId: string | null;
  config: LeadCaptureConfig;
}

/**
 * Records the visitor's answer to the consent card (LED-02, LED-08; AC-2–AC-4): the enquiry row
 * naming the purpose wording shown, and, when the opt-in was shown and they agreed, a marketing
 * row (agreed or declined) naming its own wording. A wording that is no longer current raises
 * `WordingChanged` before anything is written. Audited with codes and IDs only (ADR-014).
 */
export async function recordConsent(tx: Tx, input: ConsentInput): Promise<RecordedConsent> {
  const config = await leadCaptureConfig(tx);
  if (!config) throw new NotCapturing('no purpose statement');
  const marketingShown = config.marketing !== null;
  if (
    input.purposeWordingId !== config.purpose.wordingId ||
    (input.agreed && marketingShown !== !!input.marketing) ||
    (input.marketing && input.marketing.wordingId !== config.marketing?.wordingId)
  )
    throw new WordingChanged(config);

  const insert = async (purpose: 'enquiry' | 'marketing', agreed: boolean, wordingId: string) => {
    const [row] = await tx
      .insert(consents)
      .values({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        purpose,
        decision: agreed ? 'agreed' : 'declined',
        wordingId,
        channel: 'widget',
      })
      .returning();
    await audit.append(tx, input.tenantId, {
      action: 'consent.recorded',
      actorType: 'visitor',
      subjectType: input.conversationId ? 'conversation' : 'consent',
      subjectId: input.conversationId ?? row!.id,
      related: [{ type: 'consent', id: row!.id }],
      payload: {
        consentId: auditId(row!.id),
        purpose: auditCode(purpose),
        decision: auditCode(row!.decision),
        wordingId: auditId(wordingId),
      },
    });
    return row!.id;
  };

  const enquiry = await insert('enquiry', input.agreed, input.purposeWordingId);
  const marketing =
    input.agreed && input.marketing
      ? await insert('marketing', input.marketing.agreed, input.marketing.wordingId)
      : null;
  return { consentId: input.agreed ? enquiry : null, marketingConsentId: marketing, config };
}

/** A contact's latest consent row per purpose (FEAT-051 §5.1): its current state. */
export interface ContactConsent {
  enquiry: { decision: 'agreed' | 'declined' | 'withdrawn'; at: Date } | null;
  marketing: { decision: 'agreed' | 'declined' | 'withdrawn'; at: Date } | null;
  /** The latest full withdrawal (an enquiry `withdrawn` row), even if consent was given again. */
  withdrawnAt: Date | null;
}

/** The contact's consent state: its latest row per purpose, and its latest full withdrawal. */
export async function contactConsent(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<ContactConsent> {
  const { rows } = await tx.execute<{
    purpose: 'enquiry' | 'marketing';
    decision: 'agreed' | 'declined' | 'withdrawn';
    created_at: Date | string;
    withdrawn_at: Date | string | null;
  }>(sql`
    select distinct on (purpose) purpose, decision, created_at,
      (select max(w.created_at) from consents w
        where w.tenant_id = ${tenantId} and w.contact_id = ${contactId}
          and w.purpose = 'enquiry' and w.decision = 'withdrawn') as withdrawn_at
    from consents
    where tenant_id = ${tenantId} and contact_id = ${contactId}
    order by purpose, created_at desc, (decision = 'withdrawn') desc`);
  const of = (p: 'enquiry' | 'marketing') => {
    const r = rows.find((x) => x.purpose === p);
    return r ? { decision: r.decision, at: new Date(r.created_at) } : null;
  };
  const w = rows[0]?.withdrawn_at;
  return {
    enquiry: of('enquiry'),
    marketing: of('marketing'),
    withdrawnAt: w ? new Date(w) : null,
  };
}

export interface ConsentState {
  /** The latest enquiry answer in this conversation (FEAT-051: may be a withdrawal). */
  enquiry: 'agreed' | 'declined' | 'withdrawn' | null;
  /**
   * The latest granted enquiry consent, if any, and only while it is newer than the contact's
   * latest full withdrawal (FEAT-051 §5.1): after a withdrawal, consent must be given again.
   */
  consentId: string | null;
  /** The conversation's contact has currently withdrawn consent (FEAT-051). */
  withdrawn: boolean;
  /** A consent or form card was already shown in this conversation. */
  offered: boolean;
  /** A lead names this conversation. */
  captured: boolean;
}

/** The conversation's consent state (D2: consent is per conversation), for the agent's offer rule. */
export async function consentState(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConsentState> {
  const [latest] = await tx
    .select({ decision: consents.decision })
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, tenantId),
        eq(consents.conversationId, conversationId),
        eq(consents.purpose, 'enquiry'),
      ),
    )
    .orderBy(desc(consents.createdAt))
    .limit(1);
  const [granted] = await tx
    .select({ id: consents.id, at: consents.createdAt })
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, tenantId),
        eq(consents.conversationId, conversationId),
        eq(consents.purpose, 'enquiry'),
        eq(consents.decision, 'agreed'),
      ),
    )
    .orderBy(desc(consents.createdAt))
    .limit(1);
  const { rows } = await tx.execute<{
    offered: boolean;
    captured: boolean;
    contact_id: string | null;
  }>(sql`
    select
      exists (select 1 from messages where tenant_id = ${tenantId}
        and conversation_id = ${conversationId} and card is not null) as offered,
      exists (select 1 from leads where tenant_id = ${tenantId}
        and conversation_id = ${conversationId}) as captured,
      (select contact_id from conversations where tenant_id = ${tenantId}
        and id = ${conversationId}) as contact_id`);
  const contactId = rows[0]?.contact_id ?? null;
  const contact = contactId ? await contactConsent(tx, tenantId, contactId) : null;
  const usable =
    granted && (!contact?.withdrawnAt || granted.at.getTime() > contact.withdrawnAt.getTime());
  return {
    enquiry: latest?.decision ?? null,
    consentId: usable ? granted.id : null,
    withdrawn: contact?.enquiry?.decision === 'withdrawn',
    offered: !!rows[0]?.offered,
    captured: !!rows[0]?.captured,
  };
}
