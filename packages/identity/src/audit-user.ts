import { sql, type Tx } from '@kaki/db';
import { audit } from '@kaki/governance';

/**
 * Appends a user-level event to the chain of every workspace where the user is an active
 * member (§5.5): IDs only, payload `{}`. Leaves the transaction without a tenant context.
 */
export async function auditUserEvent(tx: Tx, userId: string, action: string): Promise<void> {
  const { rows } = await tx.execute<{ tenant_id: string }>(
    sql`select tenant_id from memberships where user_id = ${userId} and status = 'active'
        order by tenant_id`,
  );
  for (const { tenant_id } of rows) {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant_id}, true)`);
    await audit.append(tx, tenant_id, {
      action,
      actorType: 'user',
      actorId: userId,
      subjectType: 'user',
      subjectId: userId,
      payload: {},
    });
  }
  if (rows.length) await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
}
