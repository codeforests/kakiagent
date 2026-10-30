import { sql, type ZoneDb } from '@kaki/db';
import type { Role } from './capabilities.js';
import { REAUTH_WINDOW_MINUTES } from './reauth.js';
import { hashToken, isTokenShaped } from './tokens.js';

/** Who is calling, re-read from the database on every request (ADR-020, D5). */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  /** The active membership's tenant and role; null without one (no workspace yet). */
  tenantId: string | null;
  role: Role | null;
  /**
   * Two-step state, computed on every request (FEAT-006 §5.2, D2): `challenge` until an
   * enrolled user passes the code on this session, `enrol` while the active workspace
   * requires a factor the user hasn't set up.
   */
  mfa: 'ok' | 'challenge' | 'enrol';
  mfaEnrolled: boolean;
  /** A fresh authentication in the last 10 minutes (AUTH-03; `requireReauth`). */
  reauthFresh: boolean;
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
  mfa_enrolled: boolean;
  mfa_passed: boolean;
  tenant_requires_mfa: boolean;
  reauth_fresh: boolean;
}

/**
 * Validates a session token (AUTH-02, §5.2): not revoked, under 30 days old, used in the
 * last 12 hours, and its user active. The active tenant counts only while its membership
 * is active, so deactivation and role changes apply on the next request; so does the
 * two-step state.
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
          m.tenant_id, m.role, m.status as membership_status,
          f.id is not null as mfa_enrolled,
          s.mfa_at is not null as mfa_passed,
          exists (select 1 from user_mfa_required_by(s.user_id) r
                  where r.tenant_id = s.active_tenant_id) as tenant_requires_mfa,
          s.reauth_at > now() - make_interval(mins => ${REAUTH_WINDOW_MINUTES}) as reauth_fresh
        from sessions s
        join users u on u.id = s.user_id
        left join memberships m on m.tenant_id = s.active_tenant_id and m.user_id = s.user_id
        left join mfa_factors f on f.user_id = s.user_id and f.confirmed_at is not null
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
      mfa: mfaState(r),
      mfaEnrolled: r.mfa_enrolled,
      reauthFresh: r.reauth_fresh,
    },
  };
}

/** The state rule of FEAT-006 §5.2, in order. */
function mfaState(r: Row): AuthContext['mfa'] {
  if (r.mfa_enrolled && !r.mfa_passed) return 'challenge';
  if (r.tenant_requires_mfa && !r.mfa_enrolled) return 'enrol';
  return 'ok';
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
