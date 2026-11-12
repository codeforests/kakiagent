/**
 * The tenant's page-tracking mode (CHN-03; FEAT-029 §5.1, D8), stored as two booleans on
 * `widget_settings`: not enabled → `off`; enabled with consent mode → `consent`; else `on`.
 */
import type { TrackingMode } from '@kaki/contracts';
import { eq, schema, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';

const ws = schema.widgetSettings;

export function trackingMode(row: { enabled: boolean; consentMode: boolean }): TrackingMode {
  if (!row.enabled) return 'off';
  return row.consentMode ? 'consent' : 'on';
}

export function trackingColumns(mode: TrackingMode): {
  trackingEnabled: boolean;
  trackingConsentMode: boolean;
} {
  return { trackingEnabled: mode !== 'off', trackingConsentMode: mode === 'consent' };
}

/** The mode under the current tenant context (visitor or dashboard zone); `off` without a row. */
export async function visitorTrackingMode(tx: Tx, tenantId: string): Promise<TrackingMode> {
  const [row] = await tx
    .select({ enabled: ws.trackingEnabled, consentMode: ws.trackingConsentMode })
    .from(ws)
    .where(eq(ws.tenantId, tenantId));
  return row ? trackingMode(row) : 'off';
}

/** Dashboard zone, `settings.manage`: sets the mode and audits `widget.tracking_changed`. */
export async function setTrackingMode(
  ctx: { tx: Tx; tenantId: string; userId: string },
  mode: TrackingMode,
): Promise<void> {
  const from = await visitorTrackingMode(ctx.tx, ctx.tenantId);
  await ctx.tx
    .update(ws)
    .set({ ...trackingColumns(mode), trackingUpdatedAt: new Date() })
    .where(eq(ws.tenantId, ctx.tenantId));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.tracking_changed',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'widget',
    subjectId: ctx.tenantId,
    payload: { from: auditCode(from), to: auditCode(mode) },
  });
}
