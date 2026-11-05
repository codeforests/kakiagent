import { and, desc, eq, inArray, schema, sql, type Tx } from '@kaki/db';
import { URGENT_MS, type ApprovalRow } from './drafts.js';
import { gstOf } from './decide.js';
import { headline, totalsOf, type QuoteTotals, type Terms } from './quote.js';

const { approvals } = schema;

/** The queue's summary of one approval (SCR-APP-017; FEAT-055 §3 `ApprovalSummary`), minus the contact name. */
export interface ApprovalSummaryRow {
  id: string;
  kind: ApprovalRow['kind'];
  status: ApprovalRow['status'];
  conversationId: string;
  headline: string;
  totalCents: number | null;
  createdAt: string;
  slaDueAt: string;
  expiresAt: string;
  urgent: boolean;
  breached: boolean;
  afterHours: boolean;
  aboveMaxDiscount: boolean;
}

export const termsOf = (row: ApprovalRow): { draft: Terms; final: Terms | null } => ({
  draft: row.draft as unknown as Terms,
  final: (row.final as unknown as Terms | null) ?? null,
});

export function totalsFor(row: ApprovalRow): { draft: QuoteTotals; final: QuoteTotals | null } {
  const { draft, final } = termsOf(row);
  const gst = gstOf(row);
  return { draft: totalsOf(draft, gst), final: final ? totalsOf(final, gst) : null };
}

/** Pure: urgent within 30 minutes of the SLA, breached past it (pending only). */
export function summaryOf(row: ApprovalRow, now: Date = new Date()): ApprovalSummaryRow {
  const { draft, final } = termsOf(row);
  const terms = final ?? draft;
  const pending = row.status === 'pending';
  const left = row.slaDueAt.getTime() - now.getTime();
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    conversationId: row.conversationId,
    headline: headline(terms, row.request as { items: string | null }),
    totalCents: terms.lines.length ? totalsOf(terms, gstOf(row)).totalCents : null,
    createdAt: row.createdAt.toISOString(),
    slaDueAt: row.slaDueAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    urgent: pending && left > 0 && left <= URGENT_MS,
    breached: pending && left <= 0,
    afterHours: row.afterHours,
    aboveMaxDiscount: row.aboveMax,
  };
}

export const PAGE_SIZE = 50;
/** Decided approvals stay in the "Decided" view for 30 days. */
export const DECIDED_DAYS = 30;

/** A keyset cursor: `<iso time>|<id>`. */
const encode = (at: Date, id: string) => `${at.toISOString()}|${id}`;
function decode(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split('|');
  const d = new Date(at ?? '');
  return id && !Number.isNaN(d.getTime()) && /^[0-9a-f-]{36}$/i.test(id) ? { at: d, id } : null;
}

/**
 * The queue (SCR-APP-017): pending ones, urgent and breached first, then by SLA; decided ones
 * newest first, 30 days. `pendingCount` feeds the nav badge.
 */
export async function listApprovals(
  tx: Tx,
  tenantId: string,
  input: { view: 'pending' | 'decided'; cursor?: string | undefined; now?: Date },
): Promise<{ items: ApprovalRow[]; nextCursor: string | null; pendingCount: number }> {
  const now = input.now ?? new Date();
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.status, 'pending')));
  if (input.view === 'pending') {
    // At most one per conversation, so the pending set is small: sort it whole.
    const rows = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.tenantId, tenantId), eq(approvals.status, 'pending')))
      .orderBy(approvals.slaDueAt, approvals.id);
    const rank = (r: ApprovalRow) => {
      const s = summaryOf(r, now);
      return s.breached ? 0 : s.urgent ? 1 : 2;
    };
    const items = rows.sort((a, b) => rank(a) - rank(b));
    return { items, nextCursor: null, pendingCount: count };
  }
  const after = decode(input.cursor);
  const decidedAt = sql`coalesce(${approvals.decidedAt}, ${approvals.expiresAt})`;
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.tenantId, tenantId),
        inArray(approvals.status, [
          'approved',
          'edited_approved',
          'rejected',
          'expired',
          'undeliverable',
        ]),
        sql`${decidedAt} > ${new Date(now.getTime() - DECIDED_DAYS * 86_400_000)}`,
        after ? sql`(${decidedAt}, ${approvals.id}) < (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(decidedAt), desc(approvals.id))
    .limit(PAGE_SIZE + 1);
  const more = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor: more && last ? encode(last.decidedAt ?? last.expiresAt, last.id) : null,
    pendingCount: count,
  };
}

export async function approvalById(
  tx: Tx,
  tenantId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.id, approvalId)));
  return row ?? null;
}
