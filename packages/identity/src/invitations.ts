import { schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { Mailer } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import { inviteEmail, normaliseEmail } from './email.js';
import { InvitationError } from './errors.js';
import { backoffSeconds, type MagicLinkConfig } from './delivery.js';
import { hashToken, inviteToken, isTokenShaped } from './tokens.js';

export type InvitableRole = 'admin' | 'agent';

/** An invitation as the Team page lists it (contract `TeamInvitation`, FEAT-007 §3). */
export interface InvitationView {
  id: string;
  email: string;
  role: InvitableRole;
  /** The inviter's email. */
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  state: 'pending' | 'expired';
  delivery: 'sent' | 'queued';
}

/** Who is acting: the tenant and user come from the verified session only. */
export interface TeamActor {
  tenantId: string;
  userId: string;
}

/** The link the email carries; the token rides in the fragment (FEAT-005 D4). */
export const inviteUrl = (cfg: MagicLinkConfig, invitationId: string) =>
  `${cfg.appUrl.replace(/\/$/, '')}/invite#token=${inviteToken(cfg.secret, invitationId)}`;

interface ViewRow extends Record<string, unknown> {
  id: string;
  email: string;
  role: InvitableRole;
  invited_by: string;
  created_at: Date;
  expires_at: Date;
  expired: boolean;
  sent: boolean;
}

const VIEW_COLUMNS = sql`i.id, i.email, i.role, u.email as invited_by, i.created_at, i.expires_at,
  i.expires_at <= now() as expired, i.sent_at is not null as sent`;

const toView = (r: ViewRow): InvitationView => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  createdAt: new Date(r.created_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
  state: r.expired ? 'expired' : 'pending',
  delivery: r.sent ? 'sent' : 'queued',
});

/** Pending and expired invitations of the current tenant, newest first. */
export async function listInvitations(tx: Tx): Promise<InvitationView[]> {
  const { rows } = await tx.execute<ViewRow>(
    sql`select ${VIEW_COLUMNS} from invitations i join users u on u.id = i.invited_by
        where i.tenant_id = app_current_tenant() and i.accepted_at is null and i.revoked_at is null
        order by i.created_at desc, i.id`,
  );
  return rows.map(toView);
}

async function viewOf(tx: Tx, id: string): Promise<InvitationView> {
  const { rows } = await tx.execute<ViewRow>(
    sql`select ${VIEW_COLUMNS} from invitations i join users u on u.id = i.invited_by
        where i.id = ${id}`,
  );
  return toView(rows[0]!);
}

async function insertInvitation(
  tx: Tx,
  cfg: MagicLinkConfig,
  actor: TeamActor,
  email: string,
  role: InvitableRole,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(schema.invitations).values({
    tenantId: actor.tenantId,
    id,
    email,
    role,
    invitedBy: actor.userId,
    tokenHash: hashToken(inviteToken(cfg.secret, id)),
    expiresAt: sql`now() + interval '7 days'`,
    // The caller sends it at once; the sweep leaves it alone meanwhile (the magic-link rule).
    nextAttemptAt: sql`now() + interval '30 seconds'`,
  });
  return id;
}

/**
 * Invites an address as Admin or Agent (DSH-03, AUTH-04; UC-06 1–2), in one transaction:
 * refuses a current or deactivated member and a live invitation for the address; an expired
 * one is revoked and replaced. Audited with IDs and the role only (ADR-014).
 */
export async function createInvitation(
  idDb: ZoneDb,
  cfg: MagicLinkConfig,
  actor: TeamActor,
  input: { email: string; role: InvitableRole },
): Promise<InvitationView> {
  const email = normaliseEmail(input.email);
  return withTenant(idDb, actor.tenantId, async (tx) => {
    const member = await tx.execute<{ status: string }>(
      sql`select m.status from memberships m join users u on u.id = m.user_id
          where m.tenant_id = ${actor.tenantId} and u.email = ${email}`,
    );
    const status = member.rows[0]?.status;
    if (status === 'active') throw new InvitationError('already_member');
    if (status) throw new InvitationError('member_deactivated');
    const live = await tx.execute<{ id: string; expired: boolean }>(
      sql`select id, expires_at <= now() as expired from invitations
          where tenant_id = ${actor.tenantId} and email = ${email}
            and accepted_at is null and revoked_at is null`,
    );
    const prior = live.rows[0];
    if (prior && !prior.expired) throw new InvitationError('invite_pending');
    if (prior) {
      await tx.execute(sql`update invitations set revoked_at = now() where id = ${prior.id}`);
    }
    const id = await insertInvitation(tx, cfg, actor, email, input.role);
    await audit.append(tx, actor.tenantId, {
      action: 'member.invited',
      actorType: 'user',
      actorId: actor.userId,
      subjectType: 'invitation',
      subjectId: id,
      payload: { role: auditCode(input.role) },
    });
    return viewOf(tx, id);
  });
}

/**
 * A new link for a pending or expired invitation: the old row is revoked (its link stops
 * working) and a copy with a new ID, token and 7 days takes its place.
 */
export async function resendInvitation(
  idDb: ZoneDb,
  cfg: MagicLinkConfig,
  actor: TeamActor,
  invitationId: string,
): Promise<InvitationView> {
  return withTenant(idDb, actor.tenantId, async (tx) => {
    const old = await tx.execute<{ email: string; role: InvitableRole }>(
      sql`update invitations set revoked_at = now()
          where tenant_id = ${actor.tenantId} and id = ${invitationId}
            and accepted_at is null and revoked_at is null
          returning email, role`,
    );
    const row = old.rows[0];
    if (!row) throw new InvitationError('not_found');
    const id = await insertInvitation(tx, cfg, actor, row.email, row.role);
    await audit.append(tx, actor.tenantId, {
      action: 'member.invite_resent',
      actorType: 'user',
      actorId: actor.userId,
      subjectType: 'invitation',
      subjectId: id,
      payload: { previous: auditId(invitationId) },
    });
    return viewOf(tx, id);
  });
}

/** Revokes a pending or expired invitation; its link then reads as invalid. */
export async function revokeInvitation(
  idDb: ZoneDb,
  actor: TeamActor,
  invitationId: string,
): Promise<void> {
  await withTenant(idDb, actor.tenantId, async (tx) => {
    const res = await tx.execute(
      sql`update invitations set revoked_at = now()
          where tenant_id = ${actor.tenantId} and id = ${invitationId}
            and accepted_at is null and revoked_at is null`,
    );
    if (!res.rowCount) throw new InvitationError('not_found');
    await audit.append(tx, actor.tenantId, {
      action: 'member.invite_revoked',
      actorType: 'user',
      actorId: actor.userId,
      subjectType: 'invitation',
      subjectId: invitationId,
    });
  });
}

interface SendRow extends Record<string, unknown> {
  id: string;
  email: string;
  role: InvitableRole;
  send_attempts: number;
  expires_at: Date;
  tenant_name: string;
  inviter: string;
}

/** Sends one row inside its tenant's transaction; false (and a scheduled retry) on failure. */
async function deliver(tx: Tx, mailer: Mailer, cfg: MagicLinkConfig, r: SendRow): Promise<boolean> {
  try {
    await mailer.send(
      inviteEmail(r.email, {
        tenantName: r.tenant_name,
        inviter: r.inviter,
        role: r.role,
        url: inviteUrl(cfg, r.id),
        expiresAt: new Date(r.expires_at),
      }),
    );
  } catch {
    const delay = backoffSeconds(r.send_attempts + 1);
    await tx.execute(
      sql`update invitations set send_attempts = send_attempts + 1,
            next_attempt_at = now() + make_interval(secs => ${delay})
          where id = ${r.id} and sent_at is null`,
    );
    return false;
  }
  await tx.execute(
    sql`update invitations set sent_at = now(), send_attempts = send_attempts + 1 where id = ${r.id}`,
  );
  return true;
}

const SEND_COLUMNS = sql`i.id, i.email, i.role, i.send_attempts, i.expires_at,
  t.name as tenant_name, u.email as inviter`;
const SEND_FROM = sql`invitations i join tenants t on t.id = i.tenant_id join users u on u.id = i.invited_by`;
const UNSENT = sql`i.sent_at is null and i.accepted_at is null and i.revoked_at is null
  and i.expires_at > now()`;

/** The tenant of an invitation, found before any tenant context (the identity_lookup policy). */
async function tenantOf(idDb: ZoneDb, where: ReturnType<typeof sql>): Promise<string | null> {
  const { rows } = await idDb.db.execute<{ tenant_id: string }>(
    sql`select tenant_id from invitations where ${where}`,
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Sends one unsent, live invitation now (the magic-link pattern, FEAT-005 §5.3). On a
 * provider failure it schedules a retry for the sweep and returns false; it never throws
 * for one.
 */
export async function sendInvitation(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  invitationId: string,
): Promise<boolean> {
  const tenantId = await tenantOf(idDb, sql`id = ${invitationId}`);
  if (!tenantId) return false;
  return withTenant(idDb, tenantId, async (tx) => {
    const { rows } = await tx.execute<SendRow>(
      sql`select ${SEND_COLUMNS} from ${SEND_FROM} where i.id = ${invitationId} and ${UNSENT}
          for update of i skip locked`,
    );
    return rows[0] ? deliver(tx, mailer, cfg, rows[0]) : false;
  });
}

/**
 * The scheduler-worker's sweep (§5.3): re-sends due invitations, tenant by tenant, claiming
 * rows with SKIP LOCKED so two workers never send one twice; then deletes invitations that
 * ended (accepted, revoked or expired) more than 30 days ago (D9).
 */
export async function sendPendingInvitations(
  idDb: ZoneDb,
  mailer: Mailer,
  cfg: MagicLinkConfig,
  limit = 20,
): Promise<{ sent: number; failed: number; purged: number }> {
  let sent = 0;
  let failed = 0;
  let purged = 0;
  const due = await idDb.db.execute<{ tenant_id: string }>(
    sql`select distinct i.tenant_id from invitations i
        where ${UNSENT} and i.next_attempt_at <= now()`,
  );
  for (const { tenant_id } of due.rows) {
    await withTenant(idDb, tenant_id, async (tx) => {
      const { rows } = await tx.execute<SendRow>(
        sql`select ${SEND_COLUMNS} from ${SEND_FROM}
            where i.tenant_id = ${tenant_id} and ${UNSENT} and i.next_attempt_at <= now()
            order by i.next_attempt_at limit ${limit} for update of i skip locked`,
      );
      for (const r of rows) {
        if (await deliver(tx, mailer, cfg, r)) sent++;
        else failed++;
      }
    });
  }
  const ENDED = sql`coalesce(accepted_at, revoked_at, expires_at) < now() - interval '30 days'`;
  const old = await idDb.db.execute<{ tenant_id: string }>(
    sql`select distinct tenant_id from invitations where ${ENDED}`,
  );
  for (const { tenant_id } of old.rows) {
    purged += await withTenant(idDb, tenant_id, async (tx) => {
      const res = await tx.execute(
        sql`delete from invitations where tenant_id = ${tenant_id} and ${ENDED}`,
      );
      return res.rowCount ?? 0;
    });
  }
  return { sent, failed, purged };
}

/** What SCR-APP-004 shows for a token (contract `InvitationLookup`). */
export interface InvitationLookupView {
  state: 'valid' | 'expired' | 'used' | 'revoked';
  tenantName: string;
  role: InvitableRole;
  email: string;
  invitedBy: string;
  signedInAs: string | null;
}

/** Reads an invitation by its token, for the accept page; any viewer, cookie optional. */
export async function lookupInvitation(
  idDb: ZoneDb,
  token: unknown,
  viewer: { email: string } | null,
): Promise<InvitationLookupView> {
  if (!isTokenShaped(token)) throw new InvitationError('link_invalid');
  const h = hashToken(token);
  const tenantId = await tenantOf(idDb, sql`token_hash = ${h}`);
  if (!tenantId) throw new InvitationError('link_invalid');
  return withTenant(idDb, tenantId, async (tx) => {
    const { rows } = await tx.execute<{
      state: InvitationLookupView['state'];
      tenant_name: string;
      role: InvitableRole;
      email: string;
      inviter: string;
    }>(
      sql`select case when i.accepted_at is not null then 'used'
                      when i.revoked_at is not null then 'revoked'
                      when i.expires_at <= now() then 'expired'
                      else 'valid' end as state,
                 t.name as tenant_name, i.role, i.email, u.email as inviter
          from ${SEND_FROM} where i.token_hash = ${h}`,
    );
    const r = rows[0]!;
    return {
      state: r.state,
      tenantName: r.tenant_name,
      role: r.role,
      email: r.email,
      invitedBy: r.inviter,
      signedInAs: viewer?.email ?? null,
    };
  });
}

/** A live invitation's ID for this token and address, or `invite_wrong_email` (§3, magic link). */
export async function liveInvitationFor(
  idDb: ZoneDb,
  token: unknown,
  email: string,
): Promise<string> {
  if (!isTokenShaped(token)) throw new InvitationError('invite_wrong_email');
  const { rows } = await idDb.db.execute<{ id: string }>(
    sql`select id from invitations
        where token_hash = ${hashToken(token)} and email = ${normaliseEmail(email)}
          and accepted_at is null and revoked_at is null and expires_at > now()`,
  );
  if (!rows[0]) throw new InvitationError('invite_wrong_email');
  return rows[0].id;
}

/**
 * Joins one invitation inside the caller's transaction (§5.1 "Accepting"). The update is
 * the atomic claim: two accepts of one link can't both win. The tenant context comes from
 * the invitation row the token or link selected, a trusted source. Returns the tenant
 * joined, or a reason it wasn't: the caller decides whether that is an error.
 */
export async function joinInvitation(
  tx: Tx,
  match: { tokenHash: Buffer } | { id: string },
  user: { id: string; email: string },
): Promise<{ tenantId: string } | { failed: InvitationError['code'] }> {
  const where = 'tokenHash' in match ? sql`token_hash = ${match.tokenHash}` : sql`id = ${match.id}`;
  const found = await tx.execute<{ tenant_id: string }>(
    sql`select tenant_id from invitations where ${where}`,
  );
  const tenantId = found.rows[0]?.tenant_id;
  if (!tenantId) return { failed: 'link_invalid' };
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
  const won = await tx.execute<{ id: string; email: string; role: InvitableRole }>(
    sql`update invitations set accepted_at = now(), accepted_by = ${user.id}
        where ${where} and accepted_at is null and revoked_at is null and expires_at > now()
        returning id, email, role`,
  );
  const inv = won.rows[0];
  if (!inv) {
    const { rows } = await tx.execute<{ state: string }>(
      sql`select case when accepted_at is not null then 'link_used'
                      when revoked_at is not null then 'link_invalid'
                      else 'link_expired' end as state
          from invitations where ${where}`,
    );
    return { failed: rows[0]!.state as InvitationError['code'] };
  }
  if (inv.email !== normaliseEmail(user.email)) return { failed: 'invite_wrong_email' };
  await tx.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${tenantId}, ${user.id}, ${inv.role})
        on conflict (tenant_id, user_id) do nothing`,
  );
  const m = await tx.execute<{ status: string }>(
    sql`select status from memberships where tenant_id = ${tenantId} and user_id = ${user.id}`,
  );
  // A member deactivated since the invite was sent is reactivated only from the Team page.
  if (m.rows[0]?.status !== 'active') return { failed: 'link_invalid' };
  await audit.append(tx, tenantId, {
    action: 'member.joined',
    actorType: 'user',
    actorId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    payload: { role: auditCode(inv.role), invitation: auditId(inv.id) },
  });
  return { tenantId };
}

/**
 * Accepts an invitation for a signed-in user (AUTH-04, D2; UC-06 3, 3a): the session's
 * email must be the invited one, otherwise `invite_wrong_email` and the invitation stays
 * usable. The session moves to the joined tenant.
 */
export async function acceptInvitation(
  idDb: ZoneDb,
  token: unknown,
  who: { sessionId: string; userId: string; email: string },
): Promise<{ tenantId: string }> {
  if (!isTokenShaped(token)) throw new InvitationError('link_invalid');
  // Throwing rolls the claim back with the transaction, so a refused accept uses nothing up.
  return idDb.db.transaction(async (tx) => {
    const r = await joinInvitation(
      tx,
      { tokenHash: hashToken(token) },
      { id: who.userId, email: who.email },
    );
    if ('failed' in r) throw new InvitationError(r.failed);
    await tx.execute(
      sql`update sessions set active_tenant_id = ${r.tenantId} where id = ${who.sessionId}`,
    );
    return { tenantId: r.tenantId };
  });
}
