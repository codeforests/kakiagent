import {
  AuthOptions,
  CreateWorkspaceBody,
  CreateWorkspaceResponse,
  MagicLinkRequest,
  MagicLinkResponse,
  MagicLinkVerifyBody,
  MagicLinkVerifyResponse,
  Me,
  type SessionEndedEvent,
} from '@kaki/contracts';
import { eq, schema, withTenant } from '@kaki/db';
import {
  authenticate,
  can,
  canApprove,
  consumeMagicLink,
  createWorkspace,
  CURRENT_TERMS,
  OAUTH_COOKIE,
  OAUTH_COOKIE_TTL_S,
  requestMagicLink,
  revokeAllSessions,
  revokeSession,
  sendMagicLink,
  SESSION_COOKIE,
  signInWithGoogle,
  InvitationError,
  TERMS_DOCUMENTS,
  MfaChallengeError,
  MfaEnrolmentError,
  type AuthContext,
  type MagicLinkConfig,
  type Role,
} from '@kaki/identity';
import { channels, type Publisher } from '@kaki/platform';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { App, Deps } from './server.js';

/** No session (401): `expired` when a cookie was sent but its session is gone (AUTH-02). */
export class UnauthenticatedError extends Error {
  constructor(readonly expired: boolean) {
    super(expired ? 'session expired' : 'no session');
  }
}
/** Signed in, but no active workspace (403 `no_workspace`, FEAT-005 §3.6). */
export class NoWorkspaceError extends Error {}
/** Too many sign-in links (429, AUTH-01). */
export class RateLimitedError extends Error {}
/** A dependency the request can't do without is down (503). */
export class UnavailableError extends Error {}

/** A session on a tenant route: the tenant and role are present. */
export interface TenantSession {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: Role;
  /** The Owner's grant to decide approvals (D3; FEAT-007). */
  approvalRights: boolean;
  /** For `requireReauth` (AUTH-03; FEAT-006 §5.3). */
  reauthFresh: boolean;
  mfaEnrolled: boolean;
}

/** Which pending two-step states a route accepts (FEAT-006 §3); none by default. */
export interface AuthOpts {
  allow?: readonly ('challenge' | 'enrol')[];
}
export type AuthFrom = (req: FastifyRequest, opts?: AuthOpts) => Promise<AuthContext>;
export type SessionFrom = (req: FastifyRequest) => Promise<TenantSession>;
export type MeOf = (a: AuthContext) => Promise<Me>;

export const LINK_WINDOW_MS = 15 * 60_000;
export const LINKS_PER_EMAIL = 5;
const LINKS_PER_IP = 20;
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

/** Tells the realtime role to close each session's sockets (FEAT-008 §5.3), after commit. */
export async function publishSessionsEnded(
  publisher: Publisher,
  log: FastifyBaseLogger,
  sessionIds: readonly string[],
) {
  const event: SessionEndedEvent = { type: 'session_ended' };
  await Promise.all(
    sessionIds.map((id) =>
      publisher
        .publish(channels.session(id), event)
        .catch((err: unknown) => log.warn({ err }, 'session_ended publish failed')),
    ),
  );
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Where the Google callback sends each `next` (FEAT-005 §3.3, FEAT-006 §3). */
const GOOGLE_NEXT = {
  mfa: '/two-step',
  'mfa-enrol': '/two-step/setup',
  app: '/',
  'create-workspace': '/welcome',
} as const;

/** The only `next` the Google start accepts (FEAT-007 §3): back to the invitation page. */
const OAUTH_NEXT_COOKIE = 'kaki_oauth_next';

/**
 * Sign-in, sessions and workspaces (FEAT-005 design §3), plus the session readers every
 * dashboard route uses. The session is re-validated against Postgres on every request
 * (ADR-020, D5), so sign-out, expiry and deactivation apply at once.
 */
export function registerAuth(app: App, deps: Deps) {
  const { config, identityDb, dashboardDb, mailer, rateLimiter, google, publisher } = deps;
  const appOrigin = new URL(config.PUBLIC_APP_URL).origin;
  const secure = config.COOKIE_SECURE === 'true';
  const links: MagicLinkConfig = {
    secret: config.MAGIC_LINK_SECRET,
    appUrl: config.PUBLIC_APP_URL,
  };

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_MAX_AGE_S,
    });

  // CSRF, second layer after SameSite=Lax (D7): a browser always sends Origin on a
  // cross-origin POST, so a foreign one is refused before any handler runs.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== appOrigin)
      return reply.code(403).send({ error: 'forbidden', message: 'Not allowed' });
  });

  /**
   * The signed-in session. A session that still owes the code challenge or enrolment
   * (FEAT-006 §5.2) is refused unless the route allows that state, so every existing
   * route is closed to it without changing.
   */
  async function authFrom(req: FastifyRequest, opts: AuthOpts = {}): Promise<AuthContext> {
    const r = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    if (!r.ok) throw new UnauthenticatedError(r.reason !== 'missing');
    const { mfa } = r.auth;
    if (mfa !== 'ok' && !opts.allow?.includes(mfa))
      throw mfa === 'challenge' ? new MfaChallengeError() : new MfaEnrolmentError();
    return r.auth;
  }

  async function sessionFrom(req: FastifyRequest): Promise<TenantSession> {
    const a = await authFrom(req);
    if (!a.tenantId || !a.role) throw new NoWorkspaceError();
    return {
      sessionId: a.sessionId,
      userId: a.userId,
      tenantId: a.tenantId,
      role: a.role,
      approvalRights: a.approvalRights,
      reauthFresh: a.reauthFresh,
      mfaEnrolled: a.mfaEnrolled,
    };
  }

  app.get('/api/v1/auth/options', async () =>
    AuthOptions.parse({
      google: google !== null,
      terms: TERMS_DOCUMENTS.map((document) => ({ document, ...CURRENT_TERMS[document] })),
    }),
  );

  app.post('/api/v1/auth/magic-link', async (req, reply) => {
    const { email, invitation } = MagicLinkRequest.parse(req.body);
    // Counted per request, so the answer is the same for registered and unknown addresses.
    let allowed: boolean;
    try {
      const [byEmail, byIp] = await Promise.all([
        rateLimiter.hit(`rl:ml:e:${sha256(email)}`, LINKS_PER_EMAIL, LINK_WINDOW_MS),
        rateLimiter.hit(`rl:ml:ip:${req.ip}`, LINKS_PER_IP, LINK_WINDOW_MS),
      ]);
      allowed = byEmail.allowed && byIp.allowed;
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new RateLimitedError();
    let link: { id: string };
    try {
      link = await requestMagicLink(identityDb, links, email, undefined, invitation);
    } catch (err) {
      // The page sends only the invited address, so this is a bug or tampering: 400 (§3).
      if (err instanceof InvitationError)
        return reply
          .code(400)
          .send({ error: err.code, message: 'Use the address this invitation was sent to.' });
      throw err;
    }
    const sent = await sendMagicLink(identityDb, mailer, links, link.id);
    if (!sent) req.log.warn({ linkId: link.id }, 'magic link send failed; queued for retry');
    return reply.code(202).send(MagicLinkResponse.parse({ delayed: !sent }));
  });

  app.post('/api/v1/auth/magic-link/verify', async (req, reply) => {
    const { token } = MagicLinkVerifyBody.parse(req.body);
    // A re-auth link counts only in the browser of the session that asked for it (FEAT-006).
    const current = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    const result = await consumeMagicLink(
      identityDb,
      token,
      current.ok ? current.auth.sessionId : null,
      req.headers['user-agent'],
    );
    if (result.next !== 'reauthed') setSession(reply, result.token);
    return MagicLinkVerifyResponse.parse({ next: result.next });
  });

  app.get('/api/v1/auth/google/start', async (req, reply) => {
    if (!google) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    const { url, cookie } = await google.start();
    const oauthCookie = {
      path: '/api/v1/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: OAUTH_COOKIE_TTL_S,
    } as const;
    // `next` is allow-listed: only `invite` (FEAT-007 D4); anything else is ignored.
    const next = (req.query as { next?: unknown }).next;
    if (next === 'invite') reply.setCookie(OAUTH_NEXT_COOKIE, 'invite', oauthCookie);
    else reply.clearCookie(OAUTH_NEXT_COOKIE, { path: '/api/v1/auth/google' });
    return reply.setCookie(OAUTH_COOKIE, cookie, oauthCookie).redirect(url, 302);
  });

  app.get('/api/v1/auth/google/callback', async (req, reply) => {
    if (!google) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth/google' });
    const toInvite = req.cookies[OAUTH_NEXT_COOKIE] === 'invite';
    if (toInvite) reply.clearCookie(OAUTH_NEXT_COOKIE, { path: '/api/v1/auth/google' });
    try {
      const who = await google.finish(new URL(req.url, appOrigin), req.cookies[OAUTH_COOKIE]);
      const signedIn = await signInWithGoogle(identityDb, who, req.headers['user-agent']);
      setSession(reply, signedIn.token);
      // Back to the invitation, which joins (FEAT-007 D4); two-step comes first if owed.
      const invite = toInvite && (signedIn.next === 'app' || signedIn.next === 'create-workspace');
      return reply.redirect(invite ? '/invite' : GOOGLE_NEXT[signedIn.next], 302);
    } catch (err) {
      req.log.warn({ err }, 'google sign-in refused');
      return reply.redirect('/sign-in?error=google', 302);
    }
  });

  app.post('/api/v1/auth/sign-out', async (req, reply) => {
    const r = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    if (r.ok) {
      await revokeSession(identityDb, r.auth.sessionId);
      await publishSessionsEnded(publisher, req.log, [r.auth.sessionId]);
    }
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.post('/api/v1/auth/sign-out-everywhere', async (req, reply) => {
    const a = await authFrom(req, { allow: ['challenge', 'enrol'] });
    const revoked = await revokeAllSessions(identityDb, a.userId);
    await publishSessionsEnded(publisher, req.log, revoked);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  /** `Me` for an authenticated session; also the answer to accept and switch (FEAT-007 §3). */
  async function meOf(a: AuthContext): Promise<Me> {
    let tenant = null;
    if (a.tenantId) {
      const tenantId = a.tenantId;
      const [row] = await withTenant(dashboardDb, tenantId, (tx) =>
        tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)),
      );
      if (row) tenant = { id: row.id, name: row.name, status: row.status };
    }
    return Me.parse({
      user: { id: a.userId, email: a.email, displayName: a.displayName },
      role: tenant ? a.role : null,
      tenant,
      canApprove:
        tenant && a.role ? canApprove({ role: a.role, approvalRights: a.approvalRights }) : false,
      canReassign: tenant && a.role ? can(a.role, 'inbox.reassign') : false,
    });
  }

  app.get('/api/v1/me', async (req) => meOf(await authFrom(req)));

  app.post('/api/v1/workspaces', async (req, reply) => {
    const a = await authFrom(req);
    const body = CreateWorkspaceBody.parse(req.body);
    const tenant = await createWorkspace(identityDb, a, body);
    return reply.code(201).send(CreateWorkspaceResponse.parse({ tenant }));
  });

  return { authFrom, sessionFrom, meOf };
}
