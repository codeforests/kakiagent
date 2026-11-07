import type { WithdrawScope } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { cancelNotifications, notify } from '@kaki/platform/notifications';
import { contactConsent } from './consent.js';
import { ScopeNotOffered } from './errors.js';

/** Who a visitor's withdrawal applies to, and what the confirm card offers (FEAT-051 §5.2). */
export interface WithdrawalTarget {
  contactId: string;
  /** The contact's latest marketing answer is agreed: the card offers "Just stop offers" (D1). */
  offers: boolean;
  /** The contact has already withdrawn consent (latest enquiry row). */
  withdrawn: boolean;
}

/**
 * The contact a withdrawal in this conversation applies to (D2): the conversation's own, else the
 * newest contact of the same visitor's earlier conversations in this tenant; null when nothing is
 * held from this visitor. Never from the message text. Runs in either zone.
 */
export async function withdrawalTarget(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<WithdrawalTarget | null> {
  const { rows } = await tx.execute<{ contact_id: string | null }>(sql`
    select coalesce(c.contact_id, (
      select o.contact_id from conversations o
      where o.tenant_id = c.tenant_id and o.visitor_id = c.visitor_id
        and o.id <> c.id and o.contact_id is not null
      order by o.created_at desc limit 1
    )) as contact_id
    from conversations c
    where c.tenant_id = ${tenantId} and c.id = ${conversationId}`);
  const contactId = rows[0]?.contact_id ?? null;
  if (!contactId) return null;
  const state = await contactConsent(tx, tenantId, contactId);
  return {
    contactId,
    offers: state.marketing?.decision === 'agreed',
    withdrawn: state.enquiry?.decision === 'withdrawn',
  };
}

export interface WithdrawInput {
  tenantId: string;
  contactId: string;
  scope: WithdrawScope;
  channel: 'widget' | 'dashboard';
  /** The conversation the visitor withdrew in; null when staff record it. */
  conversationId: string | null;
  /** The staff member recording it (UC-28 1a); null from the widget. */
  recordedBy: string | null;
}

export interface Withdrawn {
  status: 'withdrawn' | 'already_withdrawn';
  /** The withdrawal rows written; empty when already withdrawn. */
  consentIds: string[];
}

/**
 * Records a withdrawal (LED-07; FEAT-051 §5.2; AC-3–AC-5, AC-7): append-only `withdrawn` rows
 * for what changes (`all`: the enquiry row, plus marketing when offers were agreed; `marketing`:
 * the marketing row), serialised per contact so two presses (or a press and a staff click)
 * write once. In the same transaction: the `consent.withdrawn` audit (IDs and codes only), the
 * `consent_withdrawn` alert to the team (not the recorder), and on `all` the contact's pending
 * hot-lead alerts cancelled. `marketing` when offers were never agreed → `ScopeNotOffered`.
 */
export async function withdrawConsent(tx: Tx, w: WithdrawInput): Promise<Withdrawn> {
  // An advisory lock, not `for update`: the dashboard zone has no UPDATE on contacts.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`consent:${w.tenantId}:${w.contactId}`}, 0))`,
  );
  const state = await contactConsent(tx, w.tenantId, w.contactId);
  if (state.enquiry?.decision === 'withdrawn')
    return { status: 'already_withdrawn', consentIds: [] };
  const purposes: ('enquiry' | 'marketing')[] = [];
  if (w.scope === 'all') {
    purposes.push('enquiry');
    if (state.marketing?.decision === 'agreed') purposes.push('marketing');
  } else {
    if (state.marketing?.decision === 'withdrawn')
      return { status: 'already_withdrawn', consentIds: [] };
    if (state.marketing?.decision !== 'agreed') throw new ScopeNotOffered('no offers agreed');
    purposes.push('marketing');
  }

  const consentIds: string[] = [];
  for (const purpose of purposes) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into consents (tenant_id, contact_id, conversation_id, purpose, decision, channel, recorded_by)
      values (${w.tenantId}, ${w.contactId}, ${w.conversationId}, ${purpose}, 'withdrawn',
        ${w.channel}, ${w.recordedBy})
      returning id`);
    consentIds.push(rows[0]!.id);
  }

  await audit.append(tx, w.tenantId, {
    action: 'consent.withdrawn',
    actorType: w.recordedBy ? 'user' : 'visitor',
    actorId: w.recordedBy ?? undefined,
    subjectType: 'contact',
    subjectId: w.contactId,
    related: [
      ...consentIds.map((id) => ({ type: 'consent', id })),
      ...(w.conversationId ? [{ type: 'conversation', id: w.conversationId }] : []),
    ],
    payload: {
      contactId: auditId(w.contactId),
      scope: auditCode(w.scope),
      channel: auditCode(w.channel),
      consentIds: consentIds.map(auditId),
    },
  });

  const leads = await tx.execute<{ id: string }>(sql`
    select id from leads where tenant_id = ${w.tenantId} and contact_id = ${w.contactId}
    order by created_at desc`);
  const newest = leads.rows[0];
  if (newest) {
    const members = await tx.execute<{ user_id: string }>(
      sql`select user_id from escalation_candidates()`,
    );
    await notify(tx, {
      tenantId: w.tenantId,
      kind: 'consent_withdrawn',
      recipients: members.rows.map((m) => m.user_id).filter((u) => u !== w.recordedBy),
      urgent: false,
      subject: { type: 'lead', id: newest.id },
      dedupeKey: `consent_withdrawn:${consentIds[0]!}`,
    });
  }
  if (w.scope === 'all')
    for (const l of leads.rows)
      await cancelNotifications(tx, w.tenantId, { type: 'lead', id: l.id }, 'hot_lead');

  return { status: 'withdrawn', consentIds };
}
