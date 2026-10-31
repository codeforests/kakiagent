import { schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import type { Mailer } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import { auditUserEvent } from './audit-user.js';
import { backoffSeconds, type MagicLinkConfig } from './delivery.js';
import {
  emailChangeConfirmEmail,
  emailChangeNoticeEmail,
  emailInUseEmail,
  normaliseEmail,
} from './email.js';
import { AccountError, LinkError } from './errors.js';
import { emailChangeToken, hashToken, isTokenShaped } from './tokens.js';

/** My account as SCR-APP-055 shows it (contract `Account`, FEAT-008 §3). */
export interface AccountView {
  email: string;
  displayName: string | null;
  googleLinked: boolean;
  pendingEmail: {
    email: string;
    requestedAt: string;
    expiresAt: string;
    delivery: 'sent' | 'queued';
  } | null;
}

/** The link the confirmation carries; the token rides in the fragment, as sign-in links do. */
export const emailChangeUrl = (cfg: MagicLinkConfig, changeId: string) =>
  `${cfg.appUrl.replace(/\/$/, '')}/verify-email#token=${emailChangeToken(cfg.secret, changeId)}`;

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/** A request that can still be confirmed: not ended, not expired. */
const LIVE = sql`confirmed_at is null and cancelled_at is null and expires_at > now()`;

export async function getAccount(idDb: ZoneDb, userId: string): Promise<AccountView> {
  const { rows } = await idDb.db.execute<{
    email: string;
    display_name: string | null;
    google_linked: boolean;
    new_email: string | null;
    created_at: Date | null;
    expires_at: Date | null;
    sent: boolean | null;
  }>(
    sql`select u.email, u.display_name, u.google_sub is not null as google_linked,
          c.new_email, c.created_at, c.expires_at, c.sent_at is not null as sent
        from users u
        left join email_changes c on c.user_id = u.id
          and c.confirmed_at is null and c.cancelled_at is null and c.expires_at > now()
        where u.id = ${userId}`,
  );
  const r = rows[0];
  if (!r) throw new AccountError('not_found');
  return {
    email: r.email,
    displayName: r.display_name,
    googleLinked: r.google_linked,
    pendingEmail:
      r.new_email && r.created_at && r.expires_at
        ? {
            email: r.new_email,
            requestedAt: new Date(r.created_at).toISOString(),
            expiresAt: new Date(r.expires_at).toISOString(),
            delivery: r.sent ? 'sent' : 'queued',
          }
        : null,
  };
}

/** AUTH-05 "change their profile name"; null clears it. The name is never audited. */
export async function updateProfile(
  idDb: ZoneDb,
  userId: string,
  displayName: string | null,
): Promise<AccountView> {
  await idDb.db.transaction(async (tx) => {
    await tx.execute(sql`update users set display_name = ${displayName} where id = ${userId}`);
    await auditUserEvent(tx, userId, 'account.name_changed');
  });
  return getAccount(idDb, userId);
}

/**
 * Records a change of sign-in email (AUTH-05, D2): `users.email` stays as it is until the
 * link is opened. Any earlier request ends here, so its link stops working. A taken
 * address gets an "already in use" email instead of a link, and the answer is the same
 * (D5). The sweep leaves the row alone for 30 seconds while the caller sends at once.
 */
export async function requestEmailChange(
  idDb: ZoneDb,
  cfg: MagicLinkConfig,
  userId: string,
  rawEmail: string,
): Promise<{ id: string }> {
  const newEmail = normaliseEmail(rawEmail);
  const id = randomUUID();
  await idDb.db.transaction(async (tx) => {
    // The lock orders two requests of one user, so the one-live-request index never trips.
    const { rows } = await tx.execute<{ email: string }>(
      sql`select email from users where id = ${userId} for update`,
    );
    const oldEmail = rows[0]?.email;
    if (!oldEmail) throw new AccountError('not_found');
    if (oldEmail === newEmail) throw new AccountError('same_email');
    await tx.execute(
      sql`update email_changes set cancelled_at = now()
          where user_id = ${userId} and confirmed_at is null and cancelled_at is null`,
    );
    const taken = await tx.execute(sql`select 1 from users where email = ${newEmail}`);
    await tx.insert(schema.emailChanges).values({
      id,
      userId,
      oldEmail,
      newEmail,
      tokenHash: hashToken(emailChangeToken(cfg.secret, id)),
      expiresAt: sql`now() + interval '24 hours'`,
      taken: taken.rows.length > 0,
      nextAttemptAt: sql`now() + interval '30 seconds'`,
    });
    await auditUserEvent(tx, userId, 'account.email_change_requested');
  });
  return { id };
}

interface ChangeRow extends Record<string, unknown> {
  id: string;
  old_email: string;
  new_email: string;
  taken: boolean;
  sent_at: Date | null;
  notice_sent_at: Date | null;
  send_attempts: number;
}

/**
 * Sends whichever of the row's two emails hasn't gone yet; on any failure it schedules
 * the next attempt. Never throws for a provider error. True when both have gone.
 */
async function deliver(
  tx: Tx | ZoneDb['db'],
  mailer: Mailer,
  cfg: MagicLinkConfig,
  row: ChangeRow,
): Promise<boolean> {
  let ok = true;
  if (!row.sent_at) {
    try {
      await mailer.send(
        row.taken
          ? emailInUseEmail(row.new_email)
          : emailChangeConfirmEmail(row.new_email, emailChangeUrl(cfg, row.id)),
      );
      await tx.execute(sql`update email_changes set sent_at = now() where id = ${row.id}`);
    } catch {
      ok = false;
    }
  }
  if (!row.notice_sent_at) {
    try {
      await mailer.send(emailChangeNoticeEmail(row.old_email, row.new_email));
      await tx.execute(sql`update email_changes set notice_sent_at = now() where id = ${row.id}`);
    } catch {
      ok = false;
    }
  }
  const delay = backoffSeconds(row.send_attempts + 1);
  await tx.execute(
    ok
      ? sql`update email_changes set send_attempts = send_attempts + 1 where id = ${row.id}`
      : sql`update email_changes set send_attempts = send_attempts + 1,
              next_attempt_at = now() + make_interval(secs => ${delay})
            where id = ${row.id}`,
  );
  return ok;
}

const UNSENT = sql`(sent_at is null or notice_sent_at is null)`;

/** Sends a new request's emails at once (the API calls it right after the request). */
export async function sendEmailChange(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  changeId: string,
): Promise<boolean> {
  const { rows } = await idDb.db.execute<ChangeRow>(
    sql`select id, old_email, new_email, taken, sent_at, notice_sent_at, send_attempts
        from email_changes where id = ${changeId} and ${UNSENT} and ${LIVE}`,
  );
  const row = rows[0];
  if (!row) return false;
  return deliver(idDb.db, mailer, cfg, row);
}

/**
 * The scheduler-worker's sweep (§5.3, the magic-link pattern): re-sends what is due on
 * live requests, claimed with SKIP LOCKED, then deletes rows ended more than 7 days ago (D7).
 */
export async function sendPendingEmailChanges(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  limit = 20,
): Promise<{ sent: number; failed: number; purged: number }> {
  let sent = 0;
  let failed = 0;
  await idDb.db.transaction(async (tx) => {
    const { rows } = await tx.execute<ChangeRow>(
      sql`select id, old_email, new_email, taken, sent_at, notice_sent_at, send_attempts
          from email_changes
          where ${UNSENT} and ${LIVE} and next_attempt_at <= now()
          order by next_attempt_at limit ${limit} for update skip locked`,
    );
    for (const row of rows) {
      if (await deliver(tx, mailer, cfg, row)) sent++;
      else failed++;
    }
  });
  const purged = await idDb.db.execute(
    sql`delete from email_changes
        where coalesce(confirmed_at, cancelled_at, expires_at) < now() - interval '7 days'`,
  );
  return { sent, failed, purged: purged.rowCount ?? 0 };
}

/** Cancels the pending change, if any (its link stops working). Idempotent. */
export async function cancelEmailChange(idDb: ZoneDb, userId: string): Promise<void> {
  await idDb.db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`update email_changes set cancelled_at = now()
          where user_id = ${userId} and confirmed_at is null and cancelled_at is null`,
    );
    if (res.rowCount) await auditUserEvent(tx, userId, 'account.email_change_cancelled');
  });
}

/**
 * Opens the confirmation link (§5.1). The update is the atomic claim, as for magic links;
 * a cancelled, replaced or taken request reads as `link_invalid`. If the address was
 * taken since the request, the change is refused and the claim rolls back. Confirming
 * also clears the Google link (D8) and deletes unused sign-in links for the old address,
 * which would otherwise create a new user with it. Sessions stay signed in (D9).
 */
export async function confirmEmailChange(idDb: ZoneDb, token: unknown): Promise<{ email: string }> {
  if (!isTokenShaped(token)) throw new LinkError('link_invalid');
  const h = hashToken(token);
  return idDb.db.transaction(async (tx) => {
    const won = await tx.execute<{ user_id: string; old_email: string; new_email: string }>(
      sql`update email_changes set confirmed_at = now()
          where token_hash = ${h} and confirmed_at is null and cancelled_at is null
            and not taken and expires_at > now()
          returning user_id, old_email, new_email`,
    );
    const change = won.rows[0];
    if (!change) {
      const { rows } = await tx.execute<{ used: boolean; ended: boolean }>(
        sql`select confirmed_at is not null as used, cancelled_at is not null or taken as ended
            from email_changes where token_hash = ${h}`,
      );
      const r = rows[0];
      if (!r || r.ended) throw new LinkError('link_invalid');
      throw new LinkError(r.used ? 'link_used' : 'link_expired');
    }
    const moved = await tx
      .execute(
        sql`update users set email = ${change.new_email}, google_sub = null
            where id = ${change.user_id} and email = ${change.old_email} and status = 'active'`,
      )
      .catch((e: unknown) => {
        throw isUniqueViolation(e) ? new AccountError('email_taken') : e;
      });
    if (!moved.rowCount) throw new LinkError('link_invalid');
    await tx.execute(
      sql`delete from magic_links
          where email = ${change.old_email} and purpose = 'sign_in' and consumed_at is null`,
    );
    await auditUserEvent(tx, change.user_id, 'account.email_changed');
    return { email: change.new_email };
  });
}
