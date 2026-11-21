import type { DsrObjectsJob } from '@kaki/contracts';
import { and, eq, gt, schema, sql, withTenant, type ZoneDb } from '@kaki/db';
import { notify } from '@kaki/platform/notifications';
import { auditDsr } from './requests.js';

/** Deletes attachment objects; a key that is already gone counts as deleted (idempotent). */
export interface DsrObjectStore {
  deleteKeys(keys: string[]): Promise<void>;
}

/**
 * The agent-worker's `dsr_objects` job (FEAT-061 §5.6; AC-6): removes the erased conversations'
 * attachment files from S3, then marks the request's files done and audits the count. Files go
 * first, so a crash between the two re-runs the delete (harmless) rather than losing it. A
 * redelivered job whose request is already done deletes again and changes nothing else.
 */
export async function removeDsrObjects(
  zdb: ZoneDb,
  store: DsrObjectStore,
  job: DsrObjectsJob,
): Promise<'removed' | 'already_done'> {
  for (let i = 0; i < job.keys.length; i += 1000)
    await store.deleteKeys(job.keys.slice(i, i + 1000));
  const r = schema.dsrRequests;
  return withTenant(zdb, job.tenantId, async (tx) => {
    const done = await tx
      .update(r)
      .set({
        objectsPending: 0,
        objectsDoneAt: sql`now()` as unknown as Date,
        updatedAt: sql`now()`,
      })
      .where(and(eq(r.tenantId, job.tenantId), eq(r.id, job.requestId), gt(r.objectsPending, 0)))
      .returning({ id: r.id });
    if (done.length === 0) return 'already_done';
    await auditDsr(tx, job.tenantId, {
      event: 'objects_removed',
      requestId: job.requestId,
      actor: { type: 'system' },
      payload: { count: job.keys.length },
    });
    return 'removed';
  });
}

/**
 * The scheduler's due sweep (FEAT-061 §5.6, D8): `dsr_queue_due_alerts()` marks each open or
 * verified request 7 days or less from due as alerted, across tenants; in the same transaction
 * each one alerts that tenant's active Owners and Admins (`channel_alert_recipients()`), so a
 * failure rolls the mark back and the next tick retries. The dedupe key keeps it to one alert
 * per request. Returns the number of requests alerted.
 */
export async function queueDsrDueAlerts(zdb: ZoneDb): Promise<number> {
  return zdb.db.transaction(async (tx) => {
    const due = await tx.execute<{ tenant_id: string; id: string }>(
      sql`select tenant_id, id from dsr_queue_due_alerts()`,
    );
    for (const row of due.rows) {
      await tx.execute(sql`select set_config('app.tenant_id', ${row.tenant_id}, true)`);
      const { rows } = await tx.execute<{ user_id: string }>(
        sql`select user_id from channel_alert_recipients()`,
      );
      await notify(tx, {
        tenantId: row.tenant_id,
        kind: 'dsr_due_soon',
        recipients: rows.map((x) => x.user_id),
        subject: { type: 'data_request', id: row.id },
        dedupeKey: `dsr_due_soon:${row.id}`,
      });
    }
    return due.rows.length;
  });
}
