import { schema, sql, type ZoneDb } from '@kaki/db';
import type { Mailer } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import { magicLinkEmail, normaliseEmail } from './email.js';
import { LinkError } from './errors.js';
import { hashToken, isTokenShaped, magicLinkToken } from './tokens.js';
import { findOrCreateUser, startSession, type SignedIn } from './users.js';

export interface MagicLinkConfig {
  /** `MAGIC_LINK_SECRET`: derives each link's token from its ID (D6). */
  secret: string;
  /** `PUBLIC_APP_URL`: the dashboard origin the link opens. */
  appUrl: string;
}

/** The link the email carries; the token rides in the fragment (D4). */
export const magicLinkUrl = (cfg: MagicLinkConfig, linkId: string) =>
  `${cfg.appUrl.replace(/\/$/, '')}/auth/verify#token=${magicLinkToken(cfg.secret, linkId)}`;

/**
 * Records a new link (AUTH-01): 15 minutes of validity, the token's SHA-256 only. The
 * sweep leaves it alone for 30 seconds, while the caller tries to send it at once.
 */
export async function requestMagicLink(
  idDb: ZoneDb,
  cfg: MagicLinkConfig,
  rawEmail: string,
): Promise<{ id: string }> {
  const id = randomUUID();
  await idDb.db.insert(schema.magicLinks).values({
    id,
    email: normaliseEmail(rawEmail),
    tokenHash: hashToken(magicLinkToken(cfg.secret, id)),
    expiresAt: sql`now() + interval '15 minutes'`,
    nextAttemptAt: sql`now() + interval '30 seconds'`,
  });
  return { id };
}

/** Retry delay after `attempts` failed sends: 10 s, doubling, at most 2 minutes. */
export const backoffSeconds = (attempts: number) => Math.min(10 * 2 ** (attempts - 1), 120);

/**
 * Sends one unsent, unexpired link. On failure it schedules the next attempt and
 * returns false; it never throws for a provider error (UC-01 2c, NFR-17).
 */
export async function sendMagicLink(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  linkId: string,
): Promise<boolean> {
  const { rows } = await idDb.db.execute<{ email: string; send_attempts: number }>(
    sql`select email, send_attempts from magic_links
        where id = ${linkId} and sent_at is null and consumed_at is null and expires_at > now()`,
  );
  const link = rows[0];
  if (!link) return false;
  try {
    await mailer.send(magicLinkEmail(link.email, magicLinkUrl(cfg, linkId)));
  } catch {
    const delay = backoffSeconds(link.send_attempts + 1);
    await idDb.db.execute(
      sql`update magic_links set send_attempts = send_attempts + 1,
            next_attempt_at = now() + make_interval(secs => ${delay})
          where id = ${linkId} and sent_at is null`,
    );
    return false;
  }
  await idDb.db.execute(
    sql`update magic_links set sent_at = now(), send_attempts = send_attempts + 1 where id = ${linkId}`,
  );
  return true;
}

/**
 * The scheduler-worker's sweep (§5.3): re-sends links that are due and still have a
 * minute of validity, then deletes links older than 24 hours. Rows are claimed with
 * SKIP LOCKED, so several workers never send the same link twice.
 */
export async function sendPendingMagicLinks(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  limit = 20,
): Promise<{ sent: number; failed: number; purged: number }> {
  let sent = 0;
  let failed = 0;
  await idDb.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; email: string; send_attempts: number }>(
      sql`select id, email, send_attempts from magic_links
          where sent_at is null and consumed_at is null and next_attempt_at <= now()
            and expires_at > now() + interval '1 minute'
          order by next_attempt_at limit ${limit} for update skip locked`,
    );
    for (const link of rows) {
      try {
        await mailer.send(magicLinkEmail(link.email, magicLinkUrl(cfg, link.id)));
        await tx.execute(
          sql`update magic_links set sent_at = now(), send_attempts = send_attempts + 1 where id = ${link.id}`,
        );
        sent++;
      } catch {
        const delay = backoffSeconds(link.send_attempts + 1);
        await tx.execute(
          sql`update magic_links set send_attempts = send_attempts + 1,
                next_attempt_at = now() + make_interval(secs => ${delay})
              where id = ${link.id}`,
        );
        failed++;
      }
    }
  });
  const purged = await idDb.db.execute(
    sql`delete from magic_links where created_at < now() - interval '24 hours'`,
  );
  return { sent, failed, purged: purged.rowCount ?? 0 };
}

/**
 * Consumes a link and signs its owner in (§5.4). The update is the atomic claim: two
 * concurrent verifies of one token can't both win. Failures create no session.
 */
export async function consumeMagicLink(idDb: ZoneDb, token: unknown): Promise<SignedIn> {
  if (!isTokenShaped(token)) throw new LinkError('link_invalid');
  const h = hashToken(token);
  return idDb.db.transaction(async (tx) => {
    const won = await tx.execute<{ email: string }>(
      sql`update magic_links set consumed_at = now()
          where token_hash = ${h} and consumed_at is null and expires_at > now()
          returning email`,
    );
    const email = won.rows[0]?.email;
    if (!email) {
      const { rows } = await tx.execute<{ used: boolean }>(
        sql`select consumed_at is not null as used from magic_links where token_hash = ${h}`,
      );
      if (!rows[0]) throw new LinkError('link_invalid');
      throw new LinkError(rows[0].used ? 'link_used' : 'link_expired');
    }
    const user = await findOrCreateUser(tx, email);
    // A disabled user starts no session (the claim rolls back with this error).
    if (user.status !== 'active') throw new LinkError('link_invalid');
    return startSession(tx, user.id, 'magic_link');
  });
}
