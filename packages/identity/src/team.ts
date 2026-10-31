import { sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { can, type Role } from './capabilities.js';
import { TeamError } from './errors.js';
import { listInvitations, type InvitableRole, type InvitationView } from './invitations.js';

/** A member as the Team page lists them (contract `TeamMember`, FEAT-007 §3). */
export interface TeamMemberView {
  userId: string;
  email: string;
  role: Role;
  status: 'active' | 'deactivated';
  approvalRights: boolean;
  mfaEnrolled: boolean;
  joinedAt: string;
  lastActiveAt: string | null;
  you: boolean;
}

export interface TeamView {
  members: TeamMemberView[];
  invitations: InvitationView[];
}

/** Exactly one change per request (contract `MemberPatch`). */
export type MemberPatch =
  { role: InvitableRole } | { status: 'active' | 'deactivated' } | { approvalRights: boolean };

/**
 * The current tenant's members (owner first, then active by email, then deactivated) and
 * its pending and expired invitations. Runs under the caller's `withTenant`.
 */
export async function listTeam(tx: Tx, viewerUserId: string): Promise<TeamView> {
  const { rows } = await tx.execute<{
    user_id: string;
    email: string;
    role: Role;
    status: 'active' | 'deactivated';
    approval_rights: boolean;
    mfa_enrolled: boolean;
    created_at: Date;
    last_active_at: Date | null;
  }>(
    sql`select m.user_id, u.email, m.role, m.status, m.approval_rights, m.created_at,
          exists (select 1 from mfa_factors f
                  where f.user_id = m.user_id and f.confirmed_at is not null) as mfa_enrolled,
          (select max(s.last_seen_at) from sessions s
           where s.user_id = m.user_id and s.active_tenant_id = m.tenant_id) as last_active_at
        from memberships m join users u on u.id = m.user_id
        where m.tenant_id = app_current_tenant()
        order by m.role = 'owner' desc, m.status = 'active' desc, u.email`,
  );
  return {
    members: rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      role: r.role,
      status: r.status,
      approvalRights: r.approval_rights,
      mfaEnrolled: r.mfa_enrolled,
      joinedAt: new Date(r.created_at).toISOString(),
      lastActiveAt: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
      you: r.user_id === viewerUserId,
    })),
    invitations: await listInvitations(tx),
  };
}

/**
 * Changes one member (DSH-03, UC-06 4; §5.1) in one transaction: the guards of §3, the
 * update, its audit entry and, for a role change or deactivation, the revocation of the
 * member's sessions on this tenant only (AUTH-02, D5). A role change clears approval
 * rights; reactivation keeps the stored role. `revoked` tells the caller to close the
 * member's live sockets.
 */
export async function updateMember(
  idDb: ZoneDb,
  actor: { tenantId: string; userId: string; role: Role },
  memberId: string,
  patch: MemberPatch,
): Promise<{ revoked: number; team: TeamView }> {
  return withTenant(idDb, actor.tenantId, async (tx) => {
    const found = await tx.execute<{
      role: Role;
      status: 'active' | 'deactivated';
      approval_rights: boolean;
    }>(
      sql`select role, status, approval_rights from memberships
          where tenant_id = ${actor.tenantId} and user_id = ${memberId}`,
    );
    const m = found.rows[0];
    if (!m) throw new TeamError('not_found');
    if (m.role === 'owner') throw new TeamError('owner_protected');
    if (memberId === actor.userId) throw new TeamError('self_change');
    const entry = {
      actorType: 'user' as const,
      actorId: actor.userId,
      subjectType: 'user',
      subjectId: memberId,
    };
    const where = sql`tenant_id = ${actor.tenantId} and user_id = ${memberId}`;
    let endSessions = false;

    if ('approvalRights' in patch) {
      if (!can(actor.role, 'team.grant_approval')) throw new TeamError('forbidden');
      if (m.status !== 'active') throw new TeamError('member_deactivated');
      if (m.role !== 'agent') throw new TeamError('not_agent');
      if (m.approval_rights !== patch.approvalRights) {
        await tx.execute(
          sql`update memberships set approval_rights = ${patch.approvalRights} where ${where}`,
        );
        await audit.append(tx, actor.tenantId, {
          ...entry,
          action: 'member.approval_rights_changed',
          payload: { granted: patch.approvalRights },
        });
      }
    } else if ('role' in patch) {
      if (m.status !== 'active') throw new TeamError('member_deactivated');
      if (m.role !== patch.role) {
        await tx.execute(
          sql`update memberships set role = ${patch.role}, approval_rights = false where ${where}`,
        );
        await audit.append(tx, actor.tenantId, {
          ...entry,
          action: 'member.role_changed',
          payload: { from: auditCode(m.role), to: auditCode(patch.role) },
        });
        endSessions = true;
      }
    } else if (m.status !== patch.status) {
      await tx.execute(sql`update memberships set status = ${patch.status} where ${where}`);
      const deactivated = patch.status === 'deactivated';
      await audit.append(tx, actor.tenantId, {
        ...entry,
        action: deactivated ? 'member.deactivated' : 'member.reactivated',
      });
      endSessions = deactivated;
    }

    let revoked = 0;
    if (endSessions) {
      const res = await tx.execute(
        sql`update sessions set revoked_at = now()
            where user_id = ${memberId} and active_tenant_id = ${actor.tenantId}
              and revoked_at is null`,
      );
      revoked = res.rowCount ?? 0;
    }
    return { revoked, team: await listTeam(tx, actor.userId) };
  });
}
