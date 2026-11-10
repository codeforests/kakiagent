import { sql, type Tx } from '@kaki/db';
import { ALERT_EVENTS, type AlertEvent } from './kinds.js';
import type { QuietHours } from './quiet.js';

/**
 * A member's alert preferences in one business (DSH-09; FEAT-052 §5.1, D4). Stored as opt-outs;
 * no row means the defaults. Read and written in the caller's tenant transaction.
 */
export interface Prefs {
  /** Events turned off for email. */
  emailMuted: AlertEvent[];
  /** Events turned off for Telegram (FEAT-037 §5.5). */
  telegramMuted: AlertEvent[];
  quiet: QuietHours;
}

export const DEFAULT_PREFS: Prefs = Object.freeze({
  emailMuted: [],
  telegramMuted: [],
  quiet: Object.freeze({ enabled: true, start: 22 * 60, end: 8 * 60 }),
}) as Prefs;

type PrefsRow = {
  email_muted: string[];
  telegram_muted: string[];
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
};

const events = (list: string[] | null | undefined): AlertEvent[] =>
  (list ?? []).filter((e): e is AlertEvent => (ALERT_EVENTS as readonly string[]).includes(e));

/** A row from `notification_prefs` (or null) as `Prefs`, defaults filled in. */
export function prefsOf(
  row: { [K in keyof PrefsRow]?: PrefsRow[K] | null } | null | undefined,
): Prefs {
  if (!row || row.quiet_enabled == null) {
    return { emailMuted: [], telegramMuted: [], quiet: { ...DEFAULT_PREFS.quiet } };
  }
  return {
    emailMuted: events(row.email_muted),
    telegramMuted: events(row.telegram_muted),
    quiet: { enabled: row.quiet_enabled, start: row.quiet_start ?? 0, end: row.quiet_end ?? 0 },
  };
}

export async function getPrefs(tx: Tx, tenantId: string, userId: string): Promise<Prefs> {
  const { rows } = await tx.execute<PrefsRow>(
    sql`select email_muted, telegram_muted, quiet_enabled, quiet_start, quiet_end from notification_prefs
        where tenant_id = ${tenantId} and user_id = ${userId}`,
  );
  return prefsOf(rows[0]);
}

export interface PrefsChange {
  /**
   * Listed events are set; unlisted ones keep their stored setting. `telegram` absent leaves
   * the event's Telegram setting unchanged (FEAT-037 §3).
   */
  events: { event: AlertEvent; email: boolean; telegram?: boolean | undefined }[];
  quiet: QuietHours;
}

/** Upserts the member's row; last write wins (D4). Returns what is now stored. */
export async function savePrefs(
  tx: Tx,
  tenantId: string,
  userId: string,
  change: PrefsChange,
): Promise<Prefs> {
  const current = await getPrefs(tx, tenantId, userId);
  const muted = new Set<AlertEvent>(current.emailMuted);
  const tgMuted = new Set<AlertEvent>(current.telegramMuted);
  for (const e of change.events) {
    if (e.email) muted.delete(e.event);
    else muted.add(e.event);
    if (e.telegram === true) tgMuted.delete(e.event);
    else if (e.telegram === false) tgMuted.add(e.event);
  }
  const emailMuted = ALERT_EVENTS.filter((e) => muted.has(e));
  const telegramMuted = ALERT_EVENTS.filter((e) => tgMuted.has(e));
  const arr = `{${emailMuted.join(',')}}`;
  const tgArr = `{${telegramMuted.join(',')}}`;
  const q = change.quiet;
  await tx.execute(
    sql`insert into notification_prefs
          (tenant_id, user_id, email_muted, telegram_muted, quiet_enabled, quiet_start, quiet_end,
           updated_at)
        values (${tenantId}, ${userId}, ${arr}::text[], ${tgArr}::text[], ${q.enabled},
                ${q.start}, ${q.end}, now())
        on conflict (tenant_id, user_id) do update set
          email_muted = excluded.email_muted, telegram_muted = excluded.telegram_muted,
          quiet_enabled = excluded.quiet_enabled, quiet_start = excluded.quiet_start,
          quiet_end = excluded.quiet_end, updated_at = now()`,
  );
  return { emailMuted, telegramMuted, quiet: { ...q } };
}
