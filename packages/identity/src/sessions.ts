import { sql, type ZoneDb } from '@kaki/db';
import { auditUserEvent } from './audit-user.js';
import type { Role } from './capabilities.js';
import { deviceLabel } from './device.js';
import { AccountError } from './errors.js';
import { REAUTH_WINDOW_MINUTES } from './reauth.js';
import { hashToken, isTokenShaped } from './tokens.js';

/** Who is calling, re-read from the database on every request (ADR-020, D5). */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  /** The profile name (AUTH-05; FEAT-008); null until set. */
  displayName: string | null;
  /** The active membership's tenant and role; null without one (no workspace yet). */
  tenantId: string | null;
  role: Role | null;
  /** The Owner's grant to an Agent to decide approvals (D3; FEAT-007); false without one. */
  approvalRights: boolean;
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
  display_name: string | null;
  user_status: string;
  revoked: boolean;
  expired: boolean;
  idle: boolean;
  stale: boolean;
  tenant_id: string | null;
  role: Role | null;
  membership_status: string | null;
  approval_rights: boolean | null;
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
    sql`select s.id, s.user_id, u.email, u.display_name, u.status as user_status,
          s.revoked_at is not null as revoked,
          s.expires_at <= now() as expired,
          s.last_seen_at <= now() - interval '12 hours' as idle,
          s.last_seen_at < now() - interval '60 seconds' as stale,
          m.tenant_id, m.role, m.status as membership_status, m.approval_rights,
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
      displayName: r.display_name,
      tenantId: member ? r.tenant_id : null,
      role: member ? r.role : null,
      approvalRights: member && r.approval_rights === true,
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

/** Sign out of all devices (AUTH-02): every live session of the user. Returns their IDs. */
export async function revokeAllSessions(idDb: ZoneDb, userId: string): Promise<string[]> {
  const res = await idDb.db.execute<{ id: string }>(
    sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null
        returning id`,
  );
  return res.rows.map((r) => r.id);
}

/** A device on My account (contract `DeviceSession`, FEAT-008 §3). */
export interface DeviceSessionView {
  id: string;
  device: string;
  authMethod: 'magic_link' | 'google';
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
}

/** The rules of `authenticate`: not revoked, not expired, not idle. */
const LIVE = sql`revoked_at is null and expires_at > now()
  and last_seen_at > now() - interval '12 hours'`;

/** The user's live sessions, this one first, then by last activity (AUTH-02, UC-02 6). */
export async function listSessions(
  idDb: ZoneDb,
  userId: string,
  currentSessionId: string,
): Promise<DeviceSessionView[]> {
  const { rows } = await idDb.db.execute<{
    id: string;
    user_agent: string | null;
    auth_method: 'magic_link' | 'google';
    created_at: Date;
    last_seen_at: Date;
  }>(
    sql`select id, user_agent, auth_method, created_at, last_seen_at from sessions
        where user_id = ${userId} and ${LIVE}
        order by id = ${currentSessionId} desc, last_seen_at desc, id`,
  );
  return rows.map((r) => ({
    id: r.id,
    device: deviceLabel(r.user_agent),
    authMethod: r.auth_method,
    signedInAt: new Date(r.created_at).toISOString(),
    lastActiveAt: new Date(r.last_seen_at).toISOString(),
    current: r.id === currentSessionId,
  }));
}

/**
 * Signs out one of the user's other devices. This one is `current_session` (the page
 * offers Sign out instead); someone else's, or one already ended, is `not_found`.
 */
export async function revokeOwnSession(
  idDb: ZoneDb,
  userId: string,
  sessionId: string,
  currentSessionId: string,
): Promise<void> {
  if (sessionId === currentSessionId) throw new AccountError('current_session');
  await idDb.db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`update sessions set revoked_at = now()
          where id = ${sessionId} and user_id = ${userId} and ${LIVE}`,
    );
    if (!res.rowCount) throw new AccountError('not_found');
    await auditUserEvent(tx, userId, 'session.revoked');
  });
}
