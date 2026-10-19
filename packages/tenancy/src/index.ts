import { sql, type ZoneDb } from '@kaki/db';

export interface WidgetInstall {
  tenantId: string;
  allowedOrigins: string[];
  status: 'active' | 'suspended';
}

/**
 * Resolves a public widget key to its tenant before any tenant context exists. It goes
 * through the `resolve_widget_key` SECURITY DEFINER function (migration 0001), which
 * returns exactly one tenant's install settings and nothing else, so the visitor role
 * never gets broad read access to `tenants` (ADR-005). FEAT-032 moves install settings
 * to the channels module.
 */
export async function resolveWidgetKey(zdb: ZoneDb, key: string): Promise<WidgetInstall | null> {
  const res = await zdb.db.execute<{
    tenant_id: string;
    allowed_origins: string[];
    status: 'active' | 'suspended';
  }>(sql`select tenant_id, allowed_origins, status from resolve_widget_key(${key})`);
  const row = res.rows[0];
  return row
    ? { tenantId: row.tenant_id, allowedOrigins: row.allowed_origins, status: row.status }
    : null;
}
