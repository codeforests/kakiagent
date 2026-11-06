import { randomUUID } from 'node:crypto';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { appendSystemMessage, transition, type MessageRow, type TenantHours } from '@kaki/inbox';
import { notify } from '@kaki/platform/notifications';
import { addBusinessMinutes, openStatus } from '@kaki/tenancy';
import {
  cleanRequest,
  draftLines,
  kindOf,
  parseDiscount,
  quoteText,
  totalsOf,
  type CommitmentRequest,
  type GstNote,
  type PricedProduct,
  type Terms,
} from './quote.js';
import { commitmentDecision, isAboveMax, type BoundaryRules } from './rules.js';

const { approvals } = schema;

export type ApprovalRow = typeof approvals.$inferSelect;

/** Urgent = within 30 minutes of the SLA (SRS §1.4). */
export const URGENT_MS = 30 * 60_000;
/** A pending approval expires after 7 days (APR-06). */
export const EXPIRY_MS = 7 * 24 * 3_600_000;

/** The current tenant's approvers' user IDs (owners, admins, agents with rights), any zone. */
export async function approverIds(tx: Tx): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`select user_id from approval_candidates()`);
  return res.rows.map((r) => r.user_id);
}

/** The conversation's pending approval, if any (D4: at most one). */
export async function pendingApprovalOf(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ApprovalRow | null> {
  const [row] = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.tenantId, tenantId),
        eq(approvals.conversationId, conversationId),
        eq(approvals.status, 'pending'),
      ),
    );
  return row ?? null;
}

export interface DraftInput {
  tenantId: string;
  conversationId: string;
  request: CommitmentRequest;
  /** This turn's retrieved product facts with their visitor-facing prices. */
  products: readonly PricedProduct[];
  /** `inclusive` at a GST-registered tenant (prices are quoted with GST), else `none`. */
  gst: GstNote;
  business: string;
  rules: Pick<BoundaryRules, 'maxDiscountPct' | 'quotesNeedApproval' | 'approvalSlaMinutes'>;
  rulesVersion: number | null;
  hours: TenantHours | null;
  now?: Date;
}

export type DraftResult =
  | { status: 'drafted'; approval: ApprovalRow }
  | { status: 'already_pending'; approval: ApprovalRow }
  /** D3: sent at once as an approved quote with no decider; `message` is the quote. */
  | { status: 'auto'; approval: ApprovalRow; message: MessageRow };

/**
 * Drafts an approval from a visitor's request (APR-02, UC-22 2–3; FEAT-055 §5.1), on the
 * visitor zone in the turn's transaction. A pending one for the conversation → nothing new
 * (D4). An `allowed` plain quote (D3) is sent at once. Otherwise: the row, `waiting_approval`
 * (an escalated conversation stays escalated), one code-only audit entry, one alert per
 * approver.
 */
export async function draftApproval(tx: Tx, input: DraftInput): Promise<DraftResult> {
  const { tenantId, conversationId } = input;
  const now = input.now ?? new Date();
  const pending = await pendingApprovalOf(tx, tenantId, conversationId);
  if (pending) return { status: 'already_pending', approval: pending };

  const request = cleanRequest(input.request);
  const discountPct = parseDiscount(input.request.discount);
  const lines = draftLines(
    request.items ?? undefined,
    request.quantity ?? undefined,
    input.products,
  );
  const kind = kindOf(input.request, discountPct, lines);
  const pct = discountPct ?? 0;
  const aboveMax = isAboveMax(input.rules, { discountPct: pct });
  const draft: Terms = { lines, discountPct: pct, note: '' };
  const decision = commitmentDecision(input.rules, { discountPct: pct });
  const prices = input.products
    .filter((p) => lines.some((l) => l.factId === p.factId))
    .map((p) => ({
      factId: p.factId,
      version: p.version,
      name: p.name,
      priceCents: p.priceCents,
      unit: p.unit,
      gst: p.gst,
    }));
  const base = {
    tenantId,
    conversationId,
    kind,
    request: { ...request, discountPct, gst: input.gst },
    draft: draft as unknown as Record<string, unknown>,
    prices,
    rulesVersion: input.rulesVersion,
    aboveMax,
    expiresAt: new Date(now.getTime() + EXPIRY_MS),
  };

  // D3: only a plain quote is sent at once; a date or a custom request always waits.
  if (decision === 'allowed' && kind !== 'commitment' && lines.length > 0 && !request.date) {
    const id = randomUUID();
    const totals = totalsOf(draft, input.gst);
    const message = await appendSystemMessage(tx, {
      tenantId,
      conversationId,
      body: (language) => quoteText(language, input.business, draft, totals),
      card: { kind: 'quote', approvalId: id, ...draft, totals },
    });
    const [row] = await tx
      .insert(approvals)
      .values({
        ...base,
        id,
        status: 'approved',
        final: draft as unknown as Record<string, unknown>,
        slaDueAt: now,
        urgentAt: null,
        decidedAt: now,
        deliveredMessageId: message.id,
      })
      .returning();
    await audit.append(tx, tenantId, {
      action: 'approval.auto',
      actorType: 'agent',
      subjectType: 'conversation',
      subjectId: conversationId,
      related: [{ type: 'approval', id }],
      payload: {
        approvalId: auditId(id),
        kind: auditCode(kind),
        rulesVersion: input.rulesVersion,
      },
    });
    return { status: 'auto', approval: row!, message };
  }

  const afterHours = input.hours?.hours
    ? !openStatus(input.hours.hours, input.hours.openOnPublicHolidays, now, input.hours.holidays)
        .open
    : false;
  const slaDueAt = addBusinessMinutes(
    input.hours?.hours ?? null,
    input.hours?.openOnPublicHolidays ?? false,
    now,
    input.rules.approvalSlaMinutes,
    input.hours?.holidays,
  );
  const urgentFrom = slaDueAt.getTime() - URGENT_MS;
  const urgentNow = urgentFrom <= now.getTime();
  const [row] = await tx
    .insert(approvals)
    .values({
      ...base,
      afterHours,
      slaDueAt,
      // Already within 30 minutes: the first alert is urgent, so no urgent timer.
      urgentAt: urgentNow ? null : new Date(urgentFrom),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // A concurrent turn drafted one first (the partial unique index, D4).
    const other = await pendingApprovalOf(tx, tenantId, conversationId);
    if (other) return { status: 'already_pending', approval: other };
    throw new Error('draftApproval: insert conflicted without a pending approval');
  }
  const [conv] = await tx
    .select({ status: schema.conversations.status })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, conversationId)),
    );
  if (conv?.status === 'ai')
    await transition(tx, {
      tenantId,
      conversationId,
      to: 'waiting_approval',
      actor: { type: 'agent' },
    });
  await audit.append(tx, tenantId, {
    action: 'approval.drafted',
    actorType: 'agent',
    subjectType: 'conversation',
    subjectId: conversationId,
    related: [{ type: 'approval', id: row.id }],
    payload: {
      approvalId: auditId(row.id),
      kind: auditCode(kind),
      aboveMax,
      afterHours,
      rulesVersion: input.rulesVersion,
    },
  });
  await notify(tx, {
    tenantId,
    kind: 'approval_pending',
    recipients: await approverIds(tx),
    urgent: urgentNow,
    subject: { type: 'approval', id: row.id },
    dedupeKey: `approval:${row.id}`,
  });
  return { status: 'drafted', approval: row };
}
