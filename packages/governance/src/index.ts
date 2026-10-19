import { schema, type Tx } from '@kaki/db';

export interface AuditEntry {
  action: string;
  actorType: 'visitor' | 'agent' | 'user' | 'system';
  /** An ID, never a name or email (ADR-014: the audit log carries no PII). */
  actorId?: string | undefined;
  subjectType: string;
  subjectId: string;
}

/**
 * Appends an audit event inside the caller's tenant transaction, so the event commits
 * or rolls back with the change it records. Walking-skeleton implementation: plain
 * rows. FEAT-002 adds the per-tenant hash chain, `audit_pii` and S3 anchoring behind
 * this same signature.
 */
export const audit = {
  async append(tx: Tx, tenantId: string, entry: AuditEntry): Promise<void> {
    await tx.insert(schema.auditEvents).values({
      tenantId,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
    });
  },
};
