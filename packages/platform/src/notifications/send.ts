import { sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import type { Mailer } from '../mailer.js';
import { muteEvent, type AlertChannel, type NotificationKind, type SubjectType } from './kinds.js';
import { alertLink, settingsLink, type LinkOf } from './links.js';
import { prefsOf, type Prefs } from './prefs.js';
import { inQuietHours } from './quiet.js';
import {
  alertEmail,
  alertText,
  digestEmail,
  digestText,
  type AlertItem,
  type EmailContext,
} from './templates.js';

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

/** What the Telegram port did with one message (FEAT-037 §5.5). */
export type TelegramAlertOutcome = 'sent' | 'no_channel' | { failed: 'transient' | 'auth' };

/**
 * Sends one alert to a member's linked Telegram chat (FEAT-037 §5.5, D9). The scheduler binds
 * it to `@kaki/channels`' `telegramAlerts`, which reads the link and the bot's credential in the
 * visitor zone, so the identity zone never sees a bot token and platform never imports channels.
 * `no_channel`: the member has no linked chat, or the business no bot.
 */
export interface TelegramAlertSender {
  send(m: { tenantId: string; userId: string; text: string }): Promise<TelegramAlertOutcome>;
}

export interface SendOptions {
  /** `PUBLIC_APP_URL`, the dashboard origin the links open. */
  appUrl: string;
  /** Injected in tests; the clock for quiet hours, due times and the 24-hour cut-off. */
  now?: Date;
  limit?: number;
  log?: { warn: (obj: object, msg: string) => void };
  /**
   * An alert's own link, minted per recipient at send time (FEAT-056 §5.2): the scheduler puts
   * approvals' signed link on `approval_pending` this way, so platform never imports approvals.
   * `null` (or no callback) falls back to `linkFor`.
   */
  linkOf?: LinkOf;
  /** Telegram rows go through this port; without it they are skipped as `no_channel`. */
  telegram?: TelegramAlertSender | undefined;
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
  channel: AlertChannel;
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
  telegram_muted: string[] | null;
  quiet_enabled: boolean | null;
  quiet_start: number | null;
  quiet_end: number | null;
};

const COLUMNS = sql`n.id, n.user_id, n.channel, n.kind, n.urgent, n.subject_type, n.subject_id, n.attempts,
  n.created_at, (m.status = 'active' and u.status = 'active') as active, u.email,
  t.name as business, p.email_muted, p.telegram_muted, p.quiet_enabled, p.quiet_start, p.quiet_end`;
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
const itemOf = (r: Row, tenantId: string, opts: SendOptions): AlertItem => {
  const subject = { type: r.subject_type, id: r.subject_id };
  return {
    kind: r.kind,
    urgent: r.urgent,
    at: createdAt(r),
    link: alertLink(
      opts.linkOf,
      { tenantId, userId: r.user_id, kind: r.kind, subject },
      opts.appUrl,
    ),
  };
};
const mutedFor = (prefs: Prefs, r: Row) => {
  const event = muteEvent(r.kind);
  const muted = r.channel === 'telegram' ? prefs.telegramMuted : prefs.emailMuted;
  return event !== null && muted.includes(event);
};

type Delivered = 'sent' | 'no_channel' | 'failed';

/** Sends one alert or one digest on the rows' channel (they share user and channel). */
async function deliver(
  rows: Row[],
  tenantId: string,
  mailer: Mailer,
  opts: SendOptions,
  digest: boolean,
): Promise<Delivered> {
  const first = rows[0]!;
  const items = rows.map((r) => itemOf(r, tenantId, opts));
  if (first.channel === 'telegram') {
    if (!opts.telegram) return 'no_channel';
    const ctx = { businessName: first.business };
    const text = digest ? digestText(items, ctx) : alertText(items[0]!, ctx);
    try {
      const out = await opts.telegram.send({ tenantId, userId: first.user_id, text });
      return out === 'sent' || out === 'no_channel' ? out : 'failed';
    } catch {
      return 'failed';
    }
  }
  try {
    const ctx = ctxOf(first, opts.appUrl);
    await mailer.send(digest ? digestEmail(items, ctx) : alertEmail(items[0]!, ctx));
    return 'sent';
  } catch {
    return 'failed';
  }
}

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
    } else if (r.channel === 'telegram' && !opts.telegram) {
      await skip(tx, tenantId, [r.id], 'no_channel');
      out.skipped++;
    } else if (!r.urgent && r.kind !== 'test' && inQuietHours(prefs.quiet, now)) {
      await tx.execute(
        sql`update notifications set status = 'held', held_at = ${now}
            where tenant_id = ${tenantId} and id = ${r.id}`,
      );
      out.held++;
    } else {
      const done = await deliver([r], tenantId, mailer, opts, false);
      if (done === 'sent') {
        await tx.execute(
          sql`update notifications set status = 'sent', sent_at = ${now}, attempts = attempts + 1
              where tenant_id = ${tenantId} and id = ${r.id}`,
        );
        out.sent++;
      } else if (done === 'no_channel') {
        await skip(tx, tenantId, [r.id], 'no_channel');
        out.skipped++;
      } else {
        const attempts = r.attempts + 1;
        const giveUp = now.getTime() - createdAt(r).getTime() >= GIVE_UP_MS;
        await retryOrFail(tx, tenantId, [r.id], attempts, giveUp, now);
        if (giveUp) {
          out.failed++;
          opts.log?.warn(
            { tenantId, notificationId: r.id, kind: r.kind, channel: r.channel },
            `alert ${r.channel} failed`,
          );
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
        order by n.user_id, n.channel, n.created_at for update of n skip locked`,
  );
  // One digest per member, business and channel (FEAT-037 D8).
  const byUser = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.user_id}:${r.channel}`;
    byUser.set(key, [...(byUser.get(key) ?? []), r]);
  }
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
    const done = await deliver(items, tenantId, mailer, opts, true);
    if (done === 'sent') {
      await tx.execute(
        sql`update notifications
            set status = 'sent', digest = true, sent_at = ${now}, attempts = attempts + 1
            where tenant_id = ${tenantId} and id = any(${`{${ids.join(',')}}`}::uuid[])`,
      );
      out.digests++;
      out.sent += items.length;
    } else if (done === 'no_channel') {
      await skip(tx, tenantId, ids, 'no_channel');
      out.skipped += items.length;
    } else {
      const attempts = Math.max(...items.map((r) => r.attempts)) + 1;
      const giveUp = attempts >= DIGEST_MAX_ATTEMPTS;
      await retryOrFail(tx, tenantId, ids, attempts, giveUp, now);
      if (giveUp) {
        out.failed += items.length;
        opts.log?.warn(
          { tenantId, notificationIds: ids, kind: 'digest', channel: first.channel },
          `digest ${first.channel} failed`,
        );
      }
    }
  }
}

async function skip(
  tx: Tx,
  tenantId: string,
  ids: string[],
  reason: 'muted' | 'inactive' | 'no_channel',
) {
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
