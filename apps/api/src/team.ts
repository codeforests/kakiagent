import {
  InvitationLookup,
  InvitationTokenBody,
  InviteBody,
  MemberPatch,
  TeamInvitation,
  TeamResponse,
  WorkspaceList,
  type SessionEndedEvent,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import {
  acceptInvitation,
  authenticate,
  can,
  createInvitation,
  InvitationError,
  listTeam,
  listWorkspaces,
  lookupInvitation,
  NotMemberError,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
  SESSION_COOKIE,
  switchWorkspace,
  TeamError,
  updateMember,
  type InvitationErrorCode,
  type MagicLinkConfig,
  type TeamErrorCode,
} from '@kaki/identity';
import { channels } from '@kaki/platform';
import {
  UnavailableError,
  type AuthFrom,
  type MeOf,
  type SessionFrom,
  type TenantSession,
} from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 30 invitations (new or resent) per tenant per hour (§3). */
const INVITES_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/** Too many invitations from one tenant (429 `rate_limited`). */
export class InviteRateLimitedError extends Error {}

const INVITATION_ERRORS: Record<InvitationErrorCode, { status: number; message: string }> = {
  already_member: { status: 409, message: 'This person is already on your team.' },
  member_deactivated: {
    status: 409,
    message: 'This person was deactivated. Reactivate them instead.',
  },
  invite_pending: { status: 409, message: 'This address already has a pending invitation.' },
  invite_wrong_email: { status: 403, message: 'This invitation is for another address.' },
  not_found: { status: 404, message: 'Not found' },
  link_expired: { status: 400, message: 'This invitation has expired. Ask for a new one.' },
  link_used: { status: 400, message: 'This invitation has already been used.' },
  link_invalid: { status: 400, message: 'This invitation link isn’t valid.' },
};

const TEAM_ERRORS: Record<TeamErrorCode, { status: number; message: string }> = {
  owner_protected: { status: 403, message: 'The Owner’s role can’t be changed here.' },
  self_change: { status: 409, message: 'You can’t change your own role or access.' },
  not_agent: { status: 409, message: 'Approval rights are only for Agents.' },
  member_deactivated: { status: 409, message: 'Reactivate this member first.' },
  forbidden: { status: 403, message: 'Not allowed' },
  not_found: { status: 404, message: 'Not found' },
};

/** The team errors as replies (FEAT-007 §3); null for anything else. */
export function teamErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof InvitationError) {
    const e = INVITATION_ERRORS[err.code];
    return { status: e.status, body: { error: err.code, message: e.message } };
  }
  if (err instanceof TeamError) {
    const e = TEAM_ERRORS[err.code];
    return { status: e.status, body: { error: err.code, message: e.message } };
  }
  if (err instanceof NotMemberError)
    return { status: 404, body: { error: 'not_found', message: 'Not found' } };
  if (err instanceof InviteRateLimitedError)
    return {
      status: 429,
      body: { error: 'rate_limited', message: 'Too many invitations. Try again in an hour.' },
    };
  return null;
}

/**
 * Team, invitations and workspaces (DSH-03, AUTH-04; FEAT-007 §3, §5.2). Everything runs
 * in the identity zone (D1); the tenant comes from the session, or for accepting from
 * the invitation the token selects. No re-authentication (D7).
 */
export function registerTeamRoutes(
  app: App,
  deps: Deps,
  { authFrom, sessionFrom, meOf }: { authFrom: AuthFrom; sessionFrom: SessionFrom; meOf: MeOf },
) {
  const { config, identityDb, mailer, rateLimiter, publisher } = deps;
  const links: MagicLinkConfig = {
    secret: config.MAGIC_LINK_SECRET,
    appUrl: config.PUBLIC_APP_URL,
  };

  async function manager(req: Parameters<SessionFrom>[0]): Promise<TenantSession> {
    const s = await sessionFrom(req);
    if (!can(s.role, 'team.manage')) throw new ForbiddenError('team.manage');
    return s;
  }

  async function limitInvites(tenantId: string) {
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(`rl:inv:t:${tenantId}`, INVITES_PER_HOUR, HOUR_MS)).allowed;
    } catch {
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new InviteRateLimitedError();
  }

  /** Sends at once; a failure stays queued for the scheduler's sweep (§5.3). */
  async function send(req: Parameters<SessionFrom>[0], id: string) {
    const sent = await sendInvitation(identityDb, mailer, links, id);
    if (!sent) req.log.warn({ invitationId: id }, 'invitation send failed; queued for retry');
    return sent;
  }

  app.get('/api/v1/team', async (req) => {
    const s = await manager(req);
    return TeamResponse.parse(
      await withTenant(identityDb, s.tenantId, (tx) => listTeam(tx, s.userId)),
    );
  });

  app.post('/api/v1/team/invitations', async (req, reply) => {
    const s = await manager(req);
    const body = InviteBody.parse(req.body);
    await limitInvites(s.tenantId);
    const inv = await createInvitation(identityDb, links, s, body);
    const sent = await send(req, inv.id);
    return reply
      .code(201)
      .send(TeamInvitation.parse({ ...inv, delivery: sent ? 'sent' : 'queued' }));
  });

  app.post<{ Params: { id: string } }>('/api/v1/team/invitations/:id/resend', async (req) => {
    const s = await manager(req);
    await limitInvites(s.tenantId);
    const inv = await resendInvitation(identityDb, links, s, uuidOr404(req.params.id));
    const sent = await send(req, inv.id);
    return TeamInvitation.parse({ ...inv, delivery: sent ? 'sent' : 'queued' });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/team/invitations/:id', async (req, reply) => {
    const s = await manager(req);
    await revokeInvitation(identityDb, s, uuidOr404(req.params.id));
    return reply.code(204).send();
  });

  app.patch<{ Params: { userId: string } }>('/api/v1/team/members/:userId', async (req) => {
    const s = await manager(req);
    const patch = MemberPatch.parse(req.body);
    const memberId = req.params.userId;
    if (!UUID_RE.test(memberId)) throw new TeamError('not_found');
    const { revoked, team } = await updateMember(identityDb, s, memberId, patch);
    // After commit: the member's open sockets on this tenant close (AUTH-02, D5).
    if (revoked > 0) {
      const event: SessionEndedEvent = { type: 'session_ended' };
      await publisher
        .publish(channels.member(s.tenantId, memberId), event)
        .catch((err: unknown) => req.log.warn({ err }, 'session_ended publish failed'));
    }
    return TeamResponse.parse(team);
  });

  app.post('/api/v1/invitations/lookup', async (req) => {
    const { token } = InvitationTokenBody.parse(req.body);
    const current = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    return InvitationLookup.parse(
      await lookupInvitation(identityDb, token, current.ok ? current.auth : null),
    );
  });

  app.post('/api/v1/invitations/accept', async (req) => {
    const a = await authFrom(req, { allow: ['enrol'] });
    const { token } = InvitationTokenBody.parse(req.body);
    await acceptInvitation(identityDb, token, a);
    return meOf(await authFrom(req, { allow: ['enrol'] }));
  });

  app.get('/api/v1/workspaces', async (req) => {
    const a = await authFrom(req);
    return WorkspaceList.parse({
      workspaces: await listWorkspaces(identityDb, a.userId, a.tenantId),
    });
  });

  app.post<{ Params: { tenantId: string } }>('/api/v1/workspaces/:tenantId/switch', async (req) => {
    const a = await authFrom(req, { allow: ['enrol'] });
    await switchWorkspace(identityDb, a, req.params.tenantId);
    return meOf(await authFrom(req, { allow: ['enrol'] }));
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOr404(id: string): string {
  if (!UUID_RE.test(id)) throw new InvitationError('not_found');
  return id;
}
