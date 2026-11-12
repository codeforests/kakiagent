/**
 * First-party page events from the widget (CHN-03; FEAT-029 §5.3, D3, D4). One row per view,
 * keyed by the client's view ID; `engage` only raises dwell and scroll. Nothing is stored when
 * the mode is `off`, or `consent` without an accepted choice. Visitor zone.
 */
import type { TrackEvent, TrackingMode, Utm } from '@kaki/contracts';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { piiMask } from '@kaki/platform';
import { visitorTrackingMode } from './settings.js';

const ev = schema.visitorEvents;
const choices = schema.visitorTrackingChoices;

export const TRACK_CLOCK_SKEW_MS = 60 * 60_000;

/** The client's `at`, clamped to `[now − 1 h, now]`. */
export function clampViewedAt(at: string, now: Date): Date {
  const t = Date.parse(at);
  const min = now.getTime() - TRACK_CLOCK_SKEW_MS;
  if (!Number.isFinite(t)) return now;
  return new Date(Math.min(now.getTime(), Math.max(min, t)));
}

/** `piiMask` on the path (D4), kept within the 512-character check. */
export function maskPath(path: string): string {
  return piiMask(path).slice(0, 512);
}

/** UTM values through `piiMask`, each ≤ 100; null when none is left. */
export function maskUtm(utm: Utm | undefined): Record<string, string> | null {
  if (!utm) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(utm))
    if (typeof v === 'string' && v.trim()) out[k] = piiMask(v.trim()).slice(0, 100);
  return Object.keys(out).length ? out : null;
}

/** A referrer host only (the loader sends `host`); anything else is dropped. */
export function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  const host = referrer.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? host : null;
}

/** The mode and the visitor's choice decide whether anything is stored, and how it is marked. */
export async function trackingAllowed(
  tx: Tx,
  tenantId: string,
  visitorId: string,
): Promise<{ mode: TrackingMode; store: boolean; consented: boolean }> {
  const mode = await visitorTrackingMode(tx, tenantId);
  if (mode === 'off') return { mode, store: false, consented: false };
  if (mode === 'on') return { mode, store: true, consented: false };
  const [row] = await tx
    .select({ choice: choices.choice })
    .from(choices)
    .where(and(eq(choices.tenantId, tenantId), eq(choices.visitorId, visitorId)));
  const accepted = row?.choice === 'accepted';
  return { mode, store: accepted, consented: accepted };
}

export async function recordEvents(
  tx: Tx,
  input: { tenantId: string; visitorId: string; events: TrackEvent[]; now?: Date },
): Promise<{ stored: number; mode: TrackingMode }> {
  const now = input.now ?? new Date();
  const allowed = await trackingAllowed(tx, input.tenantId, input.visitorId);
  if (!allowed.store) return { stored: 0, mode: allowed.mode };
  let stored = 0;
  for (const e of input.events) {
    if (e.type === 'view') {
      const res = await tx
        .insert(ev)
        .values({
          tenantId: input.tenantId,
          id: e.id,
          visitorId: input.visitorId,
          sessionId: e.sessionId,
          path: maskPath(e.path),
          referrer: referrerHost(e.referrer),
          utm: maskUtm(e.utm),
          consented: allowed.consented,
          viewedAt: clampViewedAt(e.at, now),
        })
        .onConflictDoNothing()
        .returning({ id: ev.id });
      stored += res.length;
    } else {
      const res = await tx
        .update(ev)
        .set({
          dwellMs: sql`greatest(${ev.dwellMs}, ${e.dwellMs})`,
          scrollPct: sql`greatest(${ev.scrollPct}, ${e.scroll})`,
        })
        .where(
          and(eq(ev.tenantId, input.tenantId), eq(ev.id, e.id), eq(ev.visitorId, input.visitorId)),
        )
        .returning({ id: ev.id });
      stored += res.length;
    }
  }
  return { stored, mode: allowed.mode };
}
