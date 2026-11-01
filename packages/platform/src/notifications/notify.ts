import { sql, type Tx } from '@kaki/db';
import type { NotificationKind, Subject } from './kinds.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotifyInput {
  tenantId: string;
  kind: NotificationKind;
  /** User IDs of the members to alert; routing is the producer's (D8). */
  recipients: string[];
  urgent?: boolean;
  subject: Subject;
  /** Same key, same recipient → one alert, so a retried producer job never alerts twice. */
  dedupeKey: string;
}

/**
 * Queues an alert for each recipient, in the producer's transaction (FEAT-052 §5.1, D2), so
 * nothing is sent unless the change commits. Preferences and quiet hours apply at send time
 * (D3). Returns the number of rows written.
 */
export async function notify(tx: Tx, n: NotifyInput): Promise<number> {
  const recipients = [...new Set(n.recipients)];
  if (recipients.length === 0) return 0;
  if (!recipients.every((r) => UUID.test(r))) throw new Error('notify: recipient is not a user ID');
  const res = await tx.execute(
    sql`insert into notifications
          (tenant_id, user_id, kind, urgent, subject_type, subject_id, dedupe_key)
        select ${n.tenantId}, r, ${n.kind}, ${n.urgent ?? false}, ${n.subject.type},
               ${n.subject.id}, ${n.dedupeKey}
        from unnest(${`{${recipients.join(',')}}`}::uuid[]) r
        on conflict (tenant_id, user_id, dedupe_key) do nothing`,
  );
  return res.rowCount ?? 0;
}

/**
 * Stops the pending and held alerts about a subject (an escalation someone claimed, an approval
 * decided), optionally of one kind only, so no email or digest mentions it. Returns the count.
 */
export async function cancelNotifications(
  tx: Tx,
  tenantId: string,
  subject: Subject,
  kind?: NotificationKind,
): Promise<number> {
  const res = await tx.execute(
    sql`update notifications set status = 'cancelled'
        where tenant_id = ${tenantId} and subject_type = ${subject.type}
          and subject_id = ${subject.id} and status in ('pending', 'held')
          ${kind ? sql`and kind = ${kind}` : sql``}`,
  );
  return res.rowCount ?? 0;
}
