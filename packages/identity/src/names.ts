import { sql, type Tx } from '@kaki/db';

/**
 * Display names for the current tenant's members (FEAT-042 D7: the thread's dividers name
 * who closed a conversation; audit entries hold only user IDs, ADR-014). The display name,
 * else the email's local part. Runs under the identity zone's `withTenant`; IDs that aren't
 * members of the tenant are left out.
 */
export async function memberNames(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; email: string; display_name: string | null }>(
    sql`select u.id, u.email, u.display_name
        from memberships m join users u on u.id = m.user_id
        where m.tenant_id = app_current_tenant()
          and u.id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.id, r.display_name ?? r.email.split('@')[0]!]));
}
