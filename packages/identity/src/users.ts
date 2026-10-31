import { schema, sql, type Tx } from '@kaki/db';
import { newSessionToken, hashToken } from './tokens.js';

export interface UserRow {
  id: string;
  status: 'active' | 'disabled';
  googleSub: string | null;
}

/** The user with this (normalised) email, created on first sign-in. */
export async function findOrCreateUser(tx: Tx, email: string): Promise<UserRow> {
  await tx.execute(sql`insert into users (email) values (${email}) on conflict (email) do nothing`);
  const { rows } = await tx.execute<{
    id: string;
    status: UserRow['status'];
    google_sub: string | null;
  }>(sql`select id, status, google_sub from users where email = ${email}`);
  const row = rows[0]!;
  return { id: row.id, status: row.status, googleSub: row.google_sub };
}

export interface SignedIn {
  /** The session cookie value. */
  token: string;
  userId: string;
  /**
   * Where the dashboard goes next: the code challenge, forced enrolment (FEAT-006 §5.2),
   * the app, or SCR-APP-003 (FEAT-005 §3.2).
   */
  next: 'mfa' | 'mfa-enrol' | 'app' | 'create-workspace';
}

/**
 * Starts a session for a user who just proved who they are (§5.4 steps 3–5). Every
 * sign-in mints a new token, so a session can't be fixed in advance. The session opens
 * `preferTenant` (a workspace just joined), else the workspace of the user's most recently
 * used session that is still an active membership, else the earliest active membership
 * (FEAT-007 D6, replacing FEAT-005 D11).
 */
export async function startSession(
  tx: Tx,
  userId: string,
  method: 'magic_link' | 'google',
  preferTenant?: string,
): Promise<SignedIn> {
  await tx.execute(sql`update users set last_sign_in_at = now() where id = ${userId}`);
  const { rows } = await tx.execute<{ tenant_id: string }>(
    sql`select tenant_id from (
          select m.tenant_id, 0 as rank, now() as at from memberships m
          where m.user_id = ${userId} and m.status = 'active' and m.tenant_id = ${preferTenant ?? null}::uuid
          union all
          select m.tenant_id, 1, max(s.last_seen_at) from sessions s
          join memberships m on m.tenant_id = s.active_tenant_id and m.user_id = s.user_id
          where s.user_id = ${userId} and m.status = 'active'
          group by m.tenant_id
          union all
          select m.tenant_id, 2, m.created_at from memberships m
          where m.user_id = ${userId} and m.status = 'active'
        ) c
        order by rank, case when rank = 1 then at end desc, at, tenant_id limit 1`,
  );
  const tenantId = rows[0]?.tenant_id ?? null;
  const token = newSessionToken();
  await tx.insert(schema.sessions).values({
    userId,
    tokenHash: hashToken(token),
    activeTenantId: tenantId,
    authMethod: method,
    expiresAt: sql`now() + interval '30 days'`,
  });
  const mfa = await tx.execute<{ enrolled: boolean; required: boolean }>(
    sql`select exists (select 1 from mfa_factors
                       where user_id = ${userId} and confirmed_at is not null) as enrolled,
               exists (select 1 from user_mfa_required_by(${userId}) r
                       where r.tenant_id = ${tenantId}) as required`,
  );
  const { enrolled, required } = mfa.rows[0]!;
  const next = enrolled ? 'mfa' : required ? 'mfa-enrol' : tenantId ? 'app' : 'create-workspace';
  return { token, userId, next };
}
