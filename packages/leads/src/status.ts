import type { LeadRow, LeadStatus } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { LeadNotFound, LeadStale, OpenLeadExists } from './errors.js';
import { leadRowOf } from './list.js';

const OPEN = new Set<LeadStatus>(['new', 'contacted']);

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/**
 * Moves a lead through the pipeline (LED-05; FEAT-050 §5.3, D4): any move, compare-and-set on
 * `version`. Same status → the row, unchanged and not audited. Reopening a won/lost lead while
 * the contact has another open one → `OpenLeadExists` (LED-09). Audited `lead.status_changed`.
 */
export async function setLeadStatus(
  tx: Tx,
  input: { tenantId: string; leadId: string; status: LeadStatus; version: number; userId: string },
): Promise<LeadRow> {
  const { tenantId, leadId, status, version } = input;
  const { rows } = await tx.execute<{
    status: LeadStatus;
    version: number;
    contact_id: string;
  }>(sql`select status, version, contact_id from leads
         where tenant_id = ${tenantId} and id = ${leadId} for update`);
  const cur = rows[0];
  if (!cur) throw new LeadNotFound('no such lead');
  if (cur.version !== version) throw new LeadStale((await leadRowOf(tx, tenantId, leadId))!);
  if (cur.status !== status) {
    if (OPEN.has(status) && !OPEN.has(cur.status)) {
      const other = await tx.execute(sql`select 1 from leads
        where tenant_id = ${tenantId} and contact_id = ${cur.contact_id} and id <> ${leadId}
          and status in ('new', 'contacted') and superseded_by is null limit 1`);
      if (other.rows.length) throw new OpenLeadExists('open lead exists');
    }
    try {
      await tx.execute(sql`update leads set status = ${status}, version = version + 1,
          status_changed_at = now(), updated_at = now()
        where tenant_id = ${tenantId} and id = ${leadId} and version = ${version}`);
    } catch (e) {
      if (isUniqueViolation(e)) throw new OpenLeadExists('open lead exists');
      throw e;
    }
    await audit.append(tx, tenantId, {
      action: 'lead.status_changed',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'lead',
      subjectId: leadId,
      payload: { leadId: auditId(leadId), from: auditCode(cur.status), to: auditCode(status) },
    });
  }
  return (await leadRowOf(tx, tenantId, leadId))!;
}
