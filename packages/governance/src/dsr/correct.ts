import type { DsrCorrectionBody } from '@kaki/contracts';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { auditCode } from '../payload.js';
import { findSubject, identifiersOf } from './find.js';
import { auditDsr, DsrError, requireVerified, type DsrRow } from './requests.js';

/**
 * Correction (UC-30 4b; FEAT-061 §5.3, D4, D15): contact display fields and the lead's
 * free-text fields through `dsr_correct()`; messages are never edited. The audit entry names
 * the fields, never the values (AC-5). The request stays verified until it is completed.
 */
export async function correctSubject(
  tx: Tx,
  tenantId: string,
  userId: string,
  requestId: string,
  body: DsrCorrectionBody,
): Promise<{ request: DsrRow; fields: string[] }> {
  const req = await requireVerified(tx, tenantId, requestId, 'correction');
  if (req.version !== body.version) throw new DsrError('state_changed');
  const found = await findSubject(tx, tenantId, identifiersOf(req));
  if (!found.contactIds.has(body.contactId)) throw new DsrError('not_in_result');
  if (body.lead) {
    const leadOk = found.result.contacts.some((c) => c.leads.some((l) => l.id === body.lead!.id));
    if (!leadOk) throw new DsrError('not_in_result');
  }
  const fields = Object.fromEntries(
    Object.entries(body.contact ?? {}).filter(([, v]) => v !== undefined),
  );
  const leadFields = body.lead
    ? Object.fromEntries(
        Object.entries({
          need: body.lead.need,
          budget: body.lead.budget,
          preferredTime: body.lead.preferredTime,
        }).filter(([, v]) => v !== undefined),
      )
    : null;
  let changed: string[];
  try {
    const { rows } = await tx.execute<{ changed: string[] }>(
      sql`select dsr_correct(${requestId}, ${body.contactId}, ${JSON.stringify(fields)}::jsonb,
        ${body.lead?.id ?? null}, ${leadFields ? JSON.stringify(leadFields) : null}::jsonb) as changed`,
    );
    changed = rows[0]?.changed ?? [];
  } catch (e) {
    const code =
      (e as { code?: string; cause?: { code?: string } }).cause?.code ??
      (e as { code?: string }).code;
    if (code === 'KD003') throw new DsrError('not_in_result');
    if (code === 'KD002') throw new DsrError('wrong_type');
    throw e;
  }
  const r = schema.dsrRequests;
  const prev = (req.outcome?.corrected as string[] | undefined) ?? [];
  const [request] = await tx
    .update(r)
    .set({
      outcome: { ...(req.outcome ?? {}), corrected: [...new Set([...prev, ...changed])] },
      updatedAt: sql`now()`,
      version: sql`${r.version} + 1`,
    })
    .where(and(eq(r.tenantId, tenantId), eq(r.id, requestId), eq(r.version, body.version)))
    .returning();
  if (!request) throw new DsrError('state_changed');
  await auditDsr(tx, tenantId, {
    event: 'corrected',
    requestId,
    actor: { type: 'user', id: userId },
    related: [{ type: 'contact', id: body.contactId }],
    payload: { fields: changed.map((f) => auditCode(f)) },
  });
  return { request, fields: changed };
}
