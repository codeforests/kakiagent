import {
  AuthOptions,
  CreateWorkspaceBody,
  CreateWorkspaceResponse,
  MagicLinkRequest,
  MagicLinkResponse,
  MagicLinkVerifyBody,
  MagicLinkVerifyResponse,
  Me,
} from '@kaki/contracts';
import { eq, schema, withTenant } from '@kaki/db';
import {
  authenticate,
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
  TERMS_DOCUMENTS,
  type AuthContext,
  type MagicLinkConfig,
  type Role,
} from '@kaki/identity';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
}

const LINK_WINDOW_MS = 15 * 60_000;
const LINKS_PER_EMAIL = 5;
const LINKS_PER_IP = 20;
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Sign-in, sessions and workspaces (FEAT-005 design §3), plus the session readers every
 * dashboard route uses. The session is re-validated against Postgres on every request
 * (ADR-020, D5), so sign-out, expiry and deactivation apply at once.
 */
export function registerAuth(app: App, deps: Deps) {
  const { config, identityDb, dashboardDb, mailer, rateLimiter, google } = deps;
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

  async function authFrom(req: FastifyRequest): Promise<AuthContext> {
    const r = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    if (!r.ok) throw new UnauthenticatedError(r.reason !== 'missing');
    return r.auth;
  }

  async function sessionFrom(req: FastifyRequest): Promise<TenantSession> {
    const a = await authFrom(req);
    if (!a.tenantId || !a.role) throw new NoWorkspaceError();
    return { sessionId: a.sessionId, userId: a.userId, tenantId: a.tenantId, role: a.role };
  }

  app.get('/api/v1/auth/options', async () =>
    AuthOptions.parse({
      google: google !== null,
      terms: TERMS_DOCUMENTS.map((document) => ({ document, ...CURRENT_TERMS[document] })),
    }),
  );

  app.post('/api/v1/auth/magic-link', async (req, reply) => {
    const { email } = MagicLinkRequest.parse(req.body);
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
    const link = await requestMagicLink(identityDb, links, email);
    const sent = await sendMagicLink(identityDb, mailer, links, link.id);
    if (!sent) req.log.warn({ linkId: link.id }, 'magic link send failed; queued for retry');
    return reply.code(202).send(MagicLinkResponse.parse({ delayed: !sent }));
  });

  app.post('/api/v1/auth/magic-link/verify', async (req, reply) => {
    const { token } = MagicLinkVerifyBody.parse(req.body);
    const signedIn = await consumeMagicLink(identityDb, token);
    setSession(reply, signedIn.token);
    return MagicLinkVerifyResponse.parse({ next: signedIn.next });
  });

  app.get('/api/v1/auth/google/start', async (_req, reply) => {
    if (!google) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    const { url, cookie } = await google.start();
    return reply
      .setCookie(OAUTH_COOKIE, cookie, {
        path: '/api/v1/auth/google',
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: OAUTH_COOKIE_TTL_S,
      })
      .redirect(url, 302);
  });

  app.get('/api/v1/auth/google/callback', async (req, reply) => {
    if (!google) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth/google' });
    try {
      const who = await google.finish(new URL(req.url, appOrigin), req.cookies[OAUTH_COOKIE]);
      const signedIn = await signInWithGoogle(identityDb, who);
      setSession(reply, signedIn.token);
      return reply.redirect(signedIn.next === 'app' ? '/' : '/welcome', 302);
    } catch (err) {
      req.log.warn({ err }, 'google sign-in refused');
      return reply.redirect('/sign-in?error=google', 302);
    }
  });

  app.post('/api/v1/auth/sign-out', async (req, reply) => {
    const r = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    if (r.ok) await revokeSession(identityDb, r.auth.sessionId);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.post('/api/v1/auth/sign-out-everywhere', async (req, reply) => {
    const a = await authFrom(req);
    await revokeAllSessions(identityDb, a.userId);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/api/v1/me', async (req) => {
    const a = await authFrom(req);
    let tenant = null;
    if (a.tenantId) {
      const tenantId = a.tenantId;
      const [row] = await withTenant(dashboardDb, tenantId, (tx) =>
        tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)),
      );
      if (row) tenant = { id: row.id, name: row.name, status: row.status };
    }
    return Me.parse({
      user: { id: a.userId, email: a.email },
      role: tenant ? a.role : null,
      tenant,
    });
  });

  app.post('/api/v1/workspaces', async (req, reply) => {
    const a = await authFrom(req);
    const body = CreateWorkspaceBody.parse(req.body);
    const tenant = await createWorkspace(identityDb, a, body);
    return reply.code(201).send(CreateWorkspaceResponse.parse({ tenant }));
  });

  return { authFrom, sessionFrom };
}
