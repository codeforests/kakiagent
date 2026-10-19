import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { entryHash, piiCommitment } from './chain.js';
import { assertAuditEntry, subjectRefs, type ActorType, type AuditEntry } from './payload.js';

interface HeadRow extends Record<string, unknown> {
  seq: string | number;
  hash: string;
  ts: Date | string;
}

/**
 * The audit log (ADR-014). Every call runs inside the caller's tenant transaction, so
 * an entry commits or rolls back with the change it records, and the head row lock
 * taken by `audit_head_lock()` serialises a tenant's appends until that transaction
 * ends.
 */
export const audit = {
  /**
   * Appends one entry to the tenant's hash chain. Rejects anything that isn't PII-free
   * by construction (`AuditPayloadError`) before writing. Personal data in `entry.pii`
   * goes to `audit_pii`; the entry keeps only its ID and a salted commitment.
   */
  async append(
    tx: Tx,
    tenantId: string,
    entry: AuditEntry,
  ): Promise<{ seq: number; hash: string }> {
    assertAuditEntry(entry);
    const { rows } = await tx.execute<HeadRow>(sql`select seq, hash, ts from audit_head_lock()`);
    const head = rows[0];
    if (!head) throw new Error('audit: no chain head (tenant context missing)');

    let piiRef: string | null = null;
    let commitment: string | null = null;
    if (entry.pii) {
      // IDs are generated here: the visitor zone may insert PII rows but not read them.
      piiRef = randomUUID();
      const salt = randomBytes(32);
      commitment = piiCommitment(salt, entry.pii.data);
      await tx.insert(schema.auditPii).values({
        tenantId,
        id: piiRef,
        contactId: entry.pii.contactId,
        salt,
        data: entry.pii.data,
      });
    }

    const ts = new Date(head.ts);
    const fields = {
      tenantId,
      seq: Number(head.seq) + 1,
      ts: ts.toISOString(),
      actorType: entry.actorType,
      actorRef: entry.actorId ?? null,
      eventType: entry.action,
      subjectRefs: subjectRefs(entry),
      payload: entry.payload ?? {},
      piiRef,
      piiCommitment: commitment,
      prevHash: head.hash,
    };
    const hash = entryHash(fields);
    await tx.insert(schema.auditEntries).values({ ...fields, ts, hash });
    return { seq: fields.seq, hash };
  },

  /**
   * Deletes a contact's audit PII, salts included, and records the erasure (ADR-014
   * decision 3). The entries that referred to the rows keep their commitments, so the
   * chain still verifies while the data can no longer be recovered or brute-forced.
   */
  async erasePii(
    tx: Tx,
    tenantId: string,
    input: { contactId: string; actor: { type: ActorType; id?: string | undefined } },
  ): Promise<{ erased: number }> {
    const res = await tx
      .delete(schema.auditPii)
      .where(
        and(eq(schema.auditPii.tenantId, tenantId), eq(schema.auditPii.contactId, input.contactId)),
      );
    const erased = res.rowCount ?? 0;
    await audit.append(tx, tenantId, {
      action: 'audit.pii_erased',
      actorType: input.actor.type,
      actorId: input.actor.id,
      subjectType: 'contact',
      subjectId: input.contactId,
      payload: { count: erased },
    });
    return { erased };
  },
};
