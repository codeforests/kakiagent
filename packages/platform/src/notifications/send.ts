import { sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import type { Mailer } from '../mailer.js';
import { muteEvent, type NotificationKind, type SubjectType } from './kinds.js';
import { linkFor, settingsLink } from './links.js';
import { prefsOf, type Prefs } from './prefs.js';
import { inQuietHours } from './quiet.js';
import { alertEmail, digestEmail, type AlertItem, type EmailContext } from './templates.js';

/** Retry delay after `attempts` failed sends: 10 s, doubling, at most 30 minutes. */
export const alertBackoffSeconds = (attempts: number) =>
  Math.min(10 * 2 ** Math.max(attempts - 1, 0), 30 * 60);

/** An alert that still can't be sent this long after it was created is marked failed. */
export const GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Ended rows are deleted after this long (D13). */
export const KEEP_DAYS = 30;

/**
 * A digest's retries give up after the number of attempts whose backoff adds up to 24 hours,
 * since its rows were created hours before the digest fell due.
 */
export const DIGEST_MAX_ATTEMPTS = (() => {
  let n = 0;
  for (let total = 0; total < GIVE_UP_MS / 1000;) total += alertBackoffSeconds(++n);
  return n;
})();

export interface SendOptions {
  /** `PUBLIC_APP_URL`, the dashboard origin the links open. */
  appUrl: string;
  /** Injected in tests; the clock for quiet hours, due times and the 24-hour cut-off. */
  now?: Date;
  limit?: number;
  log?: { warn: (obj: object, msg: string) => void };
}

export interface SendResult {
  sent: number;
  held: number;
  digests: number;
  skipped: number;
  failed: number;
  purged: number;
}

type Row = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  urgent: boolean;
  subject_type: SubjectType;
  subject_id: string;
  attempts: number;
  created_at: Date | string;
  active: boolean;
  email: string;
  business: string;
  email_muted: string[] | null;
  quiet_enabled: boolean | null;
  quiet_start: number | null;
  quiet_end: number | null;
};

const COLUMNS = sql`n.id, n.user_id, n.kind, n.urgent, n.subject_type, n.subject_id, n.attempts,
  n.created_at, (m.status = 'active' and u.status = 'active') as active, u.email,
  t.name as business, p.email_muted, p.quiet_enabled, p.quiet_start, p.quiet_end`;
const FROM = sql`notifications n
  join memberships m on m.tenant_id = n.tenant_id and m.user_id = n.user_id
  join users u on u.id = n.user_id
  join tenants t on t.id = n.tenant_id
  left join notification_prefs p on p.tenant_id = n.tenant_id and p.user_id = n.user_id`;

/**
 * The alert sender (LED-04; FEAT-052 §5.2), run by the scheduler every `NOTIFY_SWEEP_MS` in the
 * identity zone (D10). Applies each member's current preferences and quiet hours (D3), holds
 * non-urgent alerts in quiet hours and sends what was held as one digest per member and business
 * once they end (D7). Rows are locked `for update skip locked`, so parallel senders never take
 * the same alert; delivery is at least once (a crash after the provider accepted re-sends it).
 */
export async function sendDueNotifications(
  idDb: ZoneDb,
  mailer: Mailer,
  opts: SendOptions,
): Promise<SendResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  const out: SendResult = { sent: 0, held: 0, digests: 0, skipped: 0, failed: 0, purged: 0 };
  const due = await idDb.db.execute<{ tenant_id: string }>(
    sql`select distinct tenant_id from notifications
        where status in ('pending', 'held') and next_attempt_at <= ${now}`,
  );
  for (const { tenant_id } of due.rows) {
    await withTenant(idDb, tenant_id, async (tx) => {
      await sendPending(tx, tenant_id, mailer, opts, now, limit, out);
      await sendDigests(tx, tenant_id, mailer, opts, now, out);
    });
  }
  out.purged = await purge(idDb, now);
  return out;
}

const createdAt = (r: Row) => new Date(r.created_at);
const ctxOf = (r: Row, appUrl: string): EmailContext => ({
  to: r.email,
  businessName: r.business,
  settingsLink: settingsLink(appUrl),
});
const itemOf = (r: Row, appUrl: string): AlertItem => ({
  kind: r.kind,
  urgent: r.urgent,
  at: createdAt(r),
  link: linkFor(r.kind, { type: r.subject_type, id: r.subject_id }, appUrl),
});
const mutedFor = (prefs: Prefs, r: Row) => {
  const event = muteEvent(r.kind);
  return event !== null && prefs.emailMuted.includes(event);
};

async function sendPending(
  tx: Tx,
  tenantId: string,
  mailer: Mailer,
  opts: SendOptions,
  now: Date,
  limit: number,
  out: SendResult,
) {
  const { rows } = await tx.execute<Row>(
    sql`select ${COLUMNS} from ${FROM}
        where n.tenant_id = ${tenantId} and n.status = 'pending' and n.next_attempt_at <= ${now}
        order by n.created_at limit ${limit} for update of n skip locked`,
  );
  for (const r of rows) {
    const prefs = prefsOf(r);
    if (!r.active) {
      await skip(tx, tenantId, [r.id], 'inactive');
      out.skipped++;
    } else if (mutedFor(prefs, r)) {
      await skip(tx, tenantId, [r.id], 'muted');
      out.skipped++;
    } else if (!r.urgent && r.kind !== 'test' && inQuietHours(prefs.quiet, now)) {
      await tx.execute(
        sql`update notifications set status = 'held', held_at = ${now}
            where tenant_id = ${tenantId} and id = ${r.id}`,
      );
      out.held++;
    } else {
      try {
        await mailer.send(alertEmail(itemOf(r, opts.appUrl), ctxOf(r, opts.appUrl)));
        await tx.execute(
          sql`update notifications set status = 'sent', sent_at = ${now}, attempts = attempts + 1
              where tenant_id = ${tenantId} and id = ${r.id}`,
        );
        out.sent++;
      } catch {
        const attempts = r.attempts + 1;
        const giveUp = now.getTime() - createdAt(r).getTime() >= GIVE_UP_MS;
        await retryOrFail(tx, tenantId, [r.id], attempts, giveUp, now);
        if (giveUp) {
          out.failed++;
          opts.log?.warn({ tenantId, notificationId: r.id, kind: r.kind }, 'alert email failed');
        }
      }
    }
  }
}

async function sendDigests(
  tx: Tx,
  tenantId: string,
  mailer: Mailer,
  opts: SendOptions,
  now: Date,
  out: SendResult,
) {
  const { rows } = await tx.execute<Row>(
    sql`select ${COLUMNS} from ${FROM}
        where n.tenant_id = ${tenantId} and n.status = 'held' and n.next_attempt_at <= ${now}
        order by n.user_id, n.created_at for update of n skip locked`,
  );
  const byUser = new Map<string, Row[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  for (const group of byUser.values()) {
    const first = group[0]!;
    const prefs = prefsOf(first);
    if (!first.active) {
      await skip(
        tx,
        tenantId,
        group.map((r) => r.id),
        'inactive',
      );
      out.skipped += group.length;
      continue;
    }
    if (inQuietHours(prefs.quiet, now)) continue;
    // Preferences apply at send time (D3): an event muted while held is left out.
    const muted = group.filter((r) => mutedFor(prefs, r));
    if (muted.length) {
      await skip(
        tx,
        tenantId,
        muted.map((r) => r.id),
        'muted',
      );
      out.skipped += muted.length;
    }
    const items = group.filter((r) => !mutedFor(prefs, r));
    if (items.length === 0) continue;
    const ids = items.map((r) => r.id);
    try {
      await mailer.send(
        digestEmail(
          items.map((r) => itemOf(r, opts.appUrl)),
          ctxOf(first, opts.appUrl),
        ),
      );
      await tx.execute(
        sql`update notifications
            set status = 'sent', digest = true, sent_at = ${now}, attempts = attempts + 1
            where tenant_id = ${tenantId} and id = any(${`{${ids.join(',')}}`}::uuid[])`,
      );
      out.digests++;
      out.sent += items.length;
    } catch {
      const attempts = Math.max(...items.map((r) => r.attempts)) + 1;
      const giveUp = attempts >= DIGEST_MAX_ATTEMPTS;
      await retryOrFail(tx, tenantId, ids, attempts, giveUp, now);
      if (giveUp) {
        out.failed += items.length;
        opts.log?.warn({ tenantId, notificationIds: ids, kind: 'digest' }, 'digest email failed');
      }
    }
  }
}

async function skip(tx: Tx, tenantId: string, ids: string[], reason: 'muted' | 'inactive') {
  await tx.execute(
    sql`update notifications set status = 'skipped', skip_reason = ${reason}
        where tenant_id = ${tenantId} and id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
}

async function retryOrFail(
  tx: Tx,
  tenantId: string,
  ids: string[],
  attempts: number,
  giveUp: boolean,
  now: Date,
) {
  const next = new Date(now.getTime() + alertBackoffSeconds(attempts) * 1000);
  await tx.execute(
    sql`update notifications
        set attempts = ${attempts}, next_attempt_at = ${next}
            ${giveUp ? sql`, status = 'failed'` : sql``}
        where tenant_id = ${tenantId} and id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
}

async function purge(idDb: ZoneDb, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const ENDED = sql`status not in ('pending', 'held') and created_at < ${cutoff}`;
  const old = await idDb.db.execute<{ tenant_id: string }>(
    sql`select distinct tenant_id from notifications where ${ENDED}`,
  );
  let purged = 0;
  for (const { tenant_id } of old.rows) {
    purged += await withTenant(idDb, tenant_id, async (tx) => {
      const res = await tx.execute(
        sql`delete from notifications where tenant_id = ${tenant_id} and ${ENDED}`,
      );
      return res.rowCount ?? 0;
    });
  }
  return purged;
}
