import { sql, type Tx, type ZoneDb } from '@kaki/db';

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

export interface VisitorTenantState {
  aiPaused: boolean;
  businessName: string;
  gstRegistered: boolean;
}

/**
 * The current tenant's kill-switch flag and public profile values, for the visitor
 * scope (ADR-013 decision 3; FEAT-022 D10), through the `visitor_tenant_state()`
 * function (migration 0003). Null without a tenant context: callers treat that as
 * paused (fail closed).
 */
export async function visitorTenantState(tx: Tx): Promise<VisitorTenantState | null> {
  const res = await tx.execute<{
    ai_paused: boolean;
    business_name: string;
    gst_registered: boolean;
  }>(sql`select ai_paused, business_name, gst_registered from visitor_tenant_state()`);
  const row = res.rows[0];
  return row
    ? {
        aiPaused: row.ai_paused,
        businessName: row.business_name,
        gstRegistered: row.gst_registered,
      }
    : null;
}
