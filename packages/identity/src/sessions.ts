import { sql, type ZoneDb } from '@kaki/db';
import type { Role } from './capabilities.js';
import { hashToken, isTokenShaped } from './tokens.js';

/** Who is calling, re-read from the database on every request (ADR-020, D5). */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  /** The active membership's tenant and role; null without one (no workspace yet). */
  tenantId: string | null;
  role: Role | null;
}

export type AuthFailure = 'missing' | 'unknown' | 'revoked' | 'idle' | 'expired' | 'user_disabled';
export type AuthResult = { ok: true; auth: AuthContext } | { ok: false; reason: AuthFailure };

interface Row extends Record<string, unknown> {
  id: string;
  user_id: string;
  email: string;
  user_status: string;
  revoked: boolean;
  expired: boolean;
  idle: boolean;
  stale: boolean;
  tenant_id: string | null;
  role: Role | null;
  membership_status: string | null;
}

/**
 * Validates a session token (AUTH-02, §5.2): not revoked, under 30 days old, used in the
 * last 12 hours, and its user active. The active tenant counts only while its membership
 * is active, so deactivation and role changes apply on the next request.
 * `last_seen_at` moves forward at most once a minute.
 */
export async function authenticate(idDb: ZoneDb, token: string | undefined): Promise<AuthResult> {
  if (token === undefined || token === '') return { ok: false, reason: 'missing' };
  if (!isTokenShaped(token)) return { ok: false, reason: 'unknown' };
  const { rows } = await idDb.db.execute<Row>(
    sql`select s.id, s.user_id, u.email, u.status as user_status,
          s.revoked_at is not null as revoked,
          s.expires_at <= now() as expired,
          s.last_seen_at <= now() - interval '12 hours' as idle,
          s.last_seen_at < now() - interval '60 seconds' as stale,
          m.tenant_id, m.role, m.status as membership_status
        from sessions s
        join users u on u.id = s.user_id
        left join memberships m on m.tenant_id = s.active_tenant_id and m.user_id = s.user_id
        where s.token_hash = ${hashToken(token)}`,
  );
  const r = rows[0];
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.revoked) return { ok: false, reason: 'revoked' };
  if (r.expired) return { ok: false, reason: 'expired' };
  if (r.idle) return { ok: false, reason: 'idle' };
  if (r.user_status !== 'active') return { ok: false, reason: 'user_disabled' };
  if (r.stale) {
    await idDb.db.execute(
      sql`update sessions set last_seen_at = now() where id = ${r.id} and revoked_at is null`,
    );
  }
  const member = r.membership_status === 'active';
  return {
    ok: true,
    auth: {
      sessionId: r.id,
      userId: r.user_id,
      email: r.email,
      tenantId: member ? r.tenant_id : null,
      role: member ? r.role : null,
    },
  };
}

/** Sign out (UC-02 step 6). */
export async function revokeSession(idDb: ZoneDb, sessionId: string): Promise<void> {
  await idDb.db.execute(
    sql`update sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`,
  );
}

/** Sign out of all devices (AUTH-02): every live session of the user. */
export async function revokeAllSessions(idDb: ZoneDb, userId: string): Promise<number> {
  const res = await idDb.db.execute(
    sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`,
  );
  return res.rowCount ?? 0;
}
