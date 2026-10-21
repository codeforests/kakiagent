import { sql, type Tx, type ZoneDb } from '@kaki/db';
import { WeeklyHours } from './hours.js';

export {
  HORIZON_DAYS,
  hoursOn,
  Interval,
  openStatus,
  sgDay,
  sgInstant,
  sgWeekday,
  WEEKDAYS,
  WeeklyHours,
  type OpenStatus,
  type Weekday,
} from './hours.js';
export { isSgPublicHoliday, SG_HOLIDAYS_COVER_THROUGH, SG_PUBLIC_HOLIDAYS } from './sg-holidays.js';

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
  /** Reply routing policy (ADR-007 decision 1, FEAT-004 D10); its shape is llm-gateway's `RoutePolicy`. */
  routePolicy: { complexityThreshold: number; minConfidence: number; governorStep: number };
  /** Weekly opening hours (AGT-09, FEAT-023); null when not set or not valid. */
  hours: WeeklyHours | null;
  openOnPublicHolidays: boolean;
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
    route_complexity_threshold: number;
    route_min_confidence: number;
    cost_governor_step: number;
    hours: unknown;
    open_on_public_holidays: boolean;
  }>(
    sql`select ai_paused, business_name, gst_registered, route_complexity_threshold,
               route_min_confidence, cost_governor_step, hours, open_on_public_holidays
        from visitor_tenant_state()`,
  );
  const row = res.rows[0];
  return row
    ? {
        aiPaused: row.ai_paused,
        businessName: row.business_name,
        gstRegistered: row.gst_registered,
        routePolicy: {
          // `real` columns: rounded so 0.6 stays 0.6 rather than 0.6000000238.
          complexityThreshold: Math.round(Number(row.route_complexity_threshold) * 1000) / 1000,
          minConfidence: Math.round(Number(row.route_min_confidence) * 1000) / 1000,
          governorStep: Number(row.cost_governor_step),
        },
        // Invalid hours count as not set: no after-hours behaviour rather than a wrong one.
        hours: row.hours === null ? null : (WeeklyHours.safeParse(row.hours).data ?? null),
        openOnPublicHolidays: row.open_on_public_holidays,
      }
    : null;
}
