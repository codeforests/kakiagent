import type { WithdrawScope } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { appendSystemNotice, type MessageRow } from '@kaki/inbox';
import { cancelNotifications, notify } from '@kaki/platform/notifications';
import { contactConsent } from './consent.js';
import { LeadNotFound, ScopeNotOffered, WithdrawCardNotFound } from './errors.js';

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

/** The visitor's confirmation once the withdrawal is recorded (`consent_withdrawn`; ui-design). */
export function withdrawnNotice(
  scope: WithdrawScope,
  language: 'en' | 'zh',
  businessName: string,
): string {
  if (language === 'zh')
    return scope === 'all'
      ? `好了。${businessName}将停止使用您的联系资料，也不会再联系您。`
      : `好了。${businessName}不会再向您发送优惠信息，但仍会回复您的咨询。`;
  return scope === 'all'
    ? `Done. ${businessName} will stop using your contact details and won't contact you.`
    : `Done. ${businessName} won't send you offers. They can still reply about your enquiry.`;
}

export interface ChatWithdrawal {
  status: 'withdrawn' | 'already_withdrawn' | 'nothing_held';
  /** The stored `consent_withdrawn` notice; null unless something was withdrawn. */
  notice: MessageRow | null;
}

/**
 * The widget's confirm button (`POST /widget/v1/conversations/:id/withdraw`; FEAT-051 §5.4;
 * AC-3, AC-4): the message must be this conversation's agent message with a withdraw card, and
 * `marketing` only when that card offered it. The contact comes from the conversation (D2).
 * Visitor zone; the caller has checked the conversation is the visitor's.
 */
export async function withdrawInChat(
  tx: Tx,
  input: { tenantId: string; conversationId: string; messageId: string; scope: WithdrawScope },
): Promise<ChatWithdrawal> {
  const { rows } = await tx.execute<{ card: { kind?: string; offers?: boolean } | null }>(sql`
    select card from messages
    where tenant_id = ${input.tenantId} and id = ${input.messageId}
      and conversation_id = ${input.conversationId} and author = 'agent'`);
  const card = rows[0]?.card;
  if (card?.kind !== 'withdraw') throw new WithdrawCardNotFound('no withdraw card');
  if (input.scope === 'marketing' && !card.offers) throw new ScopeNotOffered('card had no offers');
  const target = await withdrawalTarget(tx, input.tenantId, input.conversationId);
  if (!target) return { status: 'nothing_held', notice: null };
  const w = await withdrawConsent(tx, {
    tenantId: input.tenantId,
    contactId: target.contactId,
    scope: input.scope,
    channel: 'widget',
    conversationId: input.conversationId,
    recordedBy: null,
  });
  if (w.status === 'already_withdrawn') return { status: w.status, notice: null };
  const [t] = await tx
    .execute<{ name: string }>(sql`select business_name as name from visitor_privacy()`)
    .then((r) => r.rows);
  const notice = await appendSystemNotice(tx, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    kind: 'consent_withdrawn',
    text: (language) => withdrawnNotice(input.scope, language, t?.name ?? 'the team'),
  });
  return { status: 'withdrawn', notice };
}

/**
 * A withdrawal staff record on the Lead page (UC-28 1a; FEAT-051 §5.4; AC-7): the lead's
 * contact, channel `dashboard`, the recorder named. Dashboard zone. Unknown lead → `LeadNotFound`.
 */
export async function withdrawLead(
  tx: Tx,
  input: { tenantId: string; leadId: string; scope: WithdrawScope; userId: string },
): Promise<Withdrawn> {
  const { rows } = await tx.execute<{ contact_id: string }>(sql`
    select contact_id from leads where tenant_id = ${input.tenantId} and id = ${input.leadId}`);
  const contactId = rows[0]?.contact_id;
  if (!contactId) throw new LeadNotFound('no such lead');
  return withdrawConsent(tx, {
    tenantId: input.tenantId,
    contactId,
    scope: input.scope,
    channel: 'dashboard',
    conversationId: null,
    recordedBy: input.userId,
  });
}
