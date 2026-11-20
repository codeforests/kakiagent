import type { DsrSelection } from '@kaki/contracts';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { enqueue } from '@kaki/platform/outbox';
import { audit } from '../audit.js';
import { maskedRequester } from './due.js';
import { scopeOf } from './export.js';
import { checkSelection, findSubject, identifiersOf } from './find.js';
import { auditDsr, DsrError, requireVerified, type DsrRow } from './requests.js';

export interface EraseOutcome {
  request: DsrRow;
  counts: Record<string, number>;
  auditSeq: number;
  objectKeys: string[];
}

/**
 * Deletes a verified deletion request's subject (UC-30 4, 5; FEAT-061 §5.4, D1–D3; AC-6), in
 * the caller's dashboard transaction: the selection is checked against a fresh find (D10),
 * the contacts' audit PII is erased (so the chain still verifies), `dsr_erase()` removes every
 * row children first, the request completes with its counts and a masked requester, and the
 * attachment files go to the agent-worker as a `dsr_objects` job. The API runs the chain check
 * after commit (D11).
 */
export async function eraseSubject(
  tx: Tx,
  tenantId: string,
  userId: string,
  requestId: string,
  version: number,
  sel: DsrSelection,
): Promise<EraseOutcome> {
  const req = await requireVerified(tx, tenantId, requestId, 'deletion');
  if (req.version !== version) throw new DsrError('state_changed');
  const found = await findSubject(tx, tenantId, identifiersOf(req));
  checkSelection(found, sel, { atLeastOne: true });
  const { contactIds } = await scopeOf(tx, tenantId, found, sel);

  let piiErased = 0;
  for (const contactId of contactIds)
    piiErased += (
      await audit.erasePii(tx, tenantId, { contactId, actor: { type: 'user', id: userId } })
    ).erased;

  const { rows } = await tx.execute<{
    out: { counts: Record<string, number>; objectKeys: string[] };
  }>(
    sql`select dsr_erase(${requestId},
      array[${sql.join(
        sel.contactIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[],
      array[${sql.join(
        sel.conversationIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[],
      array[${sql.join(
        sel.factIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[],
      array[${sql.join(
        sel.stagedFactIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) as out`,
  );
  const out = rows[0]!.out;
  const counts = { ...out.counts, audit_pii: (out.counts.audit_pii ?? 0) + piiErased };
  const objectKeys = out.objectKeys ?? [];

  const { seq } = await auditDsr(tx, tenantId, {
    event: 'erased',
    requestId,
    actor: { type: 'user', id: userId },
    payload: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
  });

  const masked = maskedRequester({
    name: req.requesterName,
    email: req.requesterEmail,
    phone: req.requesterPhone,
    telegramId: req.requesterTelegramId,
  });
  const r = schema.dsrRequests;
  const [request] = await tx
    .update(r)
    .set({
      status: 'completed',
      closedBy: userId,
      closedAt: sql`now()` as unknown as Date,
      outcome: { counts, auditSeq: seq },
      objectsPending: objectKeys.length,
      requesterName: masked.name,
      requesterEmail: masked.email,
      requesterPhone: masked.phone,
      requesterTelegramId: masked.telegramId,
      requesterErasedAt: sql`now()` as unknown as Date,
      updatedAt: sql`now()`,
      version: sql`${r.version} + 1`,
    })
    .where(and(eq(r.tenantId, tenantId), eq(r.id, requestId), eq(r.version, version)))
    .returning();
  if (!request) throw new DsrError('state_changed');

  if (objectKeys.length)
    await enqueue(tx, {
      tenantId,
      topic: 'conversation-turns',
      groupKey: `dsr:${requestId}`,
      payload: { kind: 'dsr_objects', tenantId, requestId, keys: objectKeys },
    });
  return { request, counts, auditSeq: seq, objectKeys };
}
