import cookie from '@fastify/cookie';
import { isAllowedOrigin } from '@kaki/channels';
import {
  ConversationList,
  CreateConversationResponse,
  SendMessageBody,
  SendMessageResponse,
  WidgetConfigQuery,
  WidgetConfigResponse,
  type RealtimeEvent,
} from '@kaki/contracts';
import { ping, withTenant } from '@kaki/db';
import { LinkError, SESSION_COOKIE, TermsOutdatedError } from '@kaki/identity';
import {
  appendVisitorMessage,
  createConversation,
  listConversations,
  NotFoundError,
  toMessage,
  toSummary,
} from '@kaki/inbox';
import {
  EmbeddingUnavailableError,
  FactNotFoundError,
  GstRequiredError,
  InvalidCursorError,
  InvalidFactError,
  InvalidStateError,
  InvalidWebsiteError,
  NonPublicHostError,
  PreviewStaleError,
  ConflictChangedError,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from '@kaki/kb';
import { channels, signToken, TokenError, verifyToken } from '@kaki/platform';
import { DEFAULT_BOT_NAME, DEFAULT_GREETING } from '@kaki/agent';
import {
  InvalidProfileError,
  resolveWidgetKey,
  SettingsConflictError,
  visitorTenantState,
} from '@kaki/tenancy';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  NoWorkspaceError,
  RateLimitedError,
  registerAuth,
  UnauthenticatedError,
  UnavailableError,
} from './auth.js';
import { FactNotFound, ForbiddenError, registerFactRoutes } from './facts.js';
import { createServer, type Deps } from './server.js';
import { registerConflictRoutes, toConflict } from './conflicts.js';
import { registerReviewRoutes, toPreview } from './review.js';
import { registerSettingsRoutes } from './settings.js';
import { AttestationRequiredError, registerSourceRoutes } from './sources.js';

export type { App, Deps } from './server.js';

/** Signed widget visitor token claims (ADR-016 decision 6): tenant, origin and visitor are bound. */
interface VisitorClaims {
  t: string;
  o: string;
  v: string;
  exp: number;
}

const VISITOR_TOKEN_TTL_S = 3600;

const LINK_MESSAGES: Record<LinkError['code'], string> = {
  link_expired: 'This link has expired.',
  link_used: 'This link has already been used.',
  link_invalid: "This link isn't valid.",
};

export async function buildApp(deps: Deps) {
  const { config, dashboardDb, visitorDb, publisher } = deps;
  const app = createServer(deps.logger);
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    if (
      err instanceof InvalidFactError ||
      err instanceof InvalidCursorError ||
      err instanceof InvalidProfileError
    )
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err instanceof AttestationRequiredError)
      return reply.code(400).send({
        error: 'attestation_required',
        message: 'Confirm you own or manage this website first.',
      });
    if (err instanceof InvalidWebsiteError)
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err instanceof NonPublicHostError)
      return reply.code(400).send({
        error: 'url_not_public',
        message: "We can't crawl this address. Use your website's public address.",
      });
    if (err instanceof SourceExistsError)
      return reply.code(409).send({
        error: 'source_exists',
        message: 'This website is already a source.',
        sourceId: err.sourceId,
      });
    if (
      err instanceof NotFoundError ||
      err instanceof FactNotFoundError ||
      err instanceof FactNotFound ||
      err instanceof SourceNotFoundError
    )
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (err instanceof TokenError)
      return reply.code(401).send({ error: 'unauthorized', message: 'Sign in again' });
    if (err instanceof UnauthenticatedError) {
      if (!err.expired)
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue' });
      return reply
        .clearCookie(SESSION_COOKIE, { path: '/' })
        .code(401)
        .send({ error: 'session_expired', message: 'Your session has ended. Sign in again.' });
    }
    if (err instanceof NoWorkspaceError)
      return reply
        .code(403)
        .send({ error: 'no_workspace', message: 'Create your workspace first.' });
    if (err instanceof LinkError)
      return reply.code(400).send({ error: err.code, message: LINK_MESSAGES[err.code] });
    if (err instanceof TermsOutdatedError)
      return reply.code(409).send({
        error: 'terms_outdated',
        message: 'The terms have been updated. Please review them again.',
      });
    if (err instanceof RateLimitedError)
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many sign-in links. Try again in a few minutes.',
      });
    if (err instanceof UnavailableError)
      return reply.code(503).send({ error: 'unavailable', message: 'Try again shortly' });
    if (err instanceof ForbiddenError)
      return reply.code(403).send({ error: 'forbidden', message: 'Not allowed' });
    if (err instanceof VersionConflictError)
      return reply.code(409).send({
        error: 'version_conflict',
        message: req.url.startsWith('/api/v1/kb/sources')
          ? 'This source was changed by someone else'
          : 'This fact was changed by someone else',
      });
    if (err instanceof SettingsConflictError)
      return reply.code(409).send({
        error: 'version_conflict',
        message: 'These settings were changed by someone else',
      });
    if (err instanceof InvalidStateError)
      return reply.code(409).send({ error: 'invalid_state', message: err.message });
    if (err instanceof GstRequiredError)
      return reply
        .code(400)
        .send({ error: 'gst_required', message: 'Choose whether the price includes GST' });
    if (err instanceof PreviewStaleError)
      return reply.code(409).send({
        error: 'preview_stale',
        message: 'Some facts changed since you checked; check the new count',
        preview: toPreview(err.preview),
      });
    if (err instanceof ConflictChangedError)
      return reply.code(409).send({
        error: 'conflict_changed',
        message: 'This conflict changed since you loaded it',
        conflict: err.conflict ? toConflict(err.conflict) : null,
      });
    if (err instanceof EmbeddingUnavailableError)
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'Saving is unavailable; try again shortly' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  /** Post-commit notification only: the event is already in Postgres (ADR-017). */
  async function notify(channelNames: string[], event: RealtimeEvent) {
    try {
      await Promise.all(channelNames.map((c) => publisher.publish(c, event)));
    } catch (err) {
      deps.logger.warn({ err }, 'publish failed; clients will resume from Postgres');
    }
  }

  // ---- Health (ADR-021) -------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await Promise.all([ping(dashboardDb), ping(visitorDb)]).then(
      (r) => r.every(Boolean),
      () => false,
    );
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });

  // ---- Widget API (visitor trust zone) ------------------------------------------------
  // CORS: preflights are answered for any origin (they grant nothing); every real
  // request re-checks the Origin against the tenant's allowed origins (CHN-11).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/widget/')) return;
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-origin', origin ?? '*')
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'authorization, content-type, x-kaki-visitor')
        .header('access-control-max-age', '600')
        .header('vary', 'origin')
        .code(204)
        .send();
    }
  });
  app.options('/widget/*', async () => undefined);

  function visitorFrom(req: FastifyRequest, reply: FastifyReply): VisitorClaims {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token) throw new TokenError('missing token');
    const claims = verifyToken<VisitorClaims>(token, config.VISITOR_TOKEN_SECRET);
    if (req.headers.origin !== claims.o) throw new TokenError('origin mismatch');
    reply.header('access-control-allow-origin', claims.o).header('vary', 'origin');
    return claims;
  }

  app.get('/widget/v1/config', async (req, reply) => {
    const { key } = WidgetConfigQuery.parse(req.query);
    const origin = req.headers.origin;
    const install = await resolveWidgetKey(visitorDb, key);
    // "Not here": the loader stays silent (ADR-016 decision 6). Same response for an
    // unknown key, a wrong origin and a suspended tenant.
    if (
      !install ||
      install.status !== 'active' ||
      !origin ||
      !isAllowedOrigin(origin, install.allowedOrigins)
    ) {
      return reply.code(404).send({ error: 'not_here', message: 'Widget not available here' });
    }
    const asked = req.headers['x-kaki-visitor'];
    const visitorId =
      typeof asked === 'string' && /^[0-9a-f-]{36}$/i.test(asked) ? asked : randomUUID();
    const token = signToken(
      {
        t: install.tenantId,
        o: origin,
        v: visitorId,
        exp: Math.floor(Date.now() / 1000) + VISITOR_TOKEN_TTL_S,
      },
      config.VISITOR_TOKEN_SECRET,
    );
    // FEAT-024: the tenant's name and greeting, through the visitor zone's function only.
    const persona = (await withTenant(visitorDb, install.tenantId, visitorTenantState))?.persona;
    reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    return WidgetConfigResponse.parse({
      token,
      visitorId,
      realtimeUrl: config.PUBLIC_REALTIME_URL,
      panelUrl: config.PUBLIC_WIDGET_PANEL_URL,
      botName: persona?.botName ?? DEFAULT_BOT_NAME,
      greeting: {
        en: persona?.greeting.en ?? DEFAULT_GREETING.en,
        zh: persona?.greeting.zh ?? DEFAULT_GREETING.zh,
      },
    });
  });

  app.post('/widget/v1/conversations', async (req, reply) => {
    const v = visitorFrom(req, reply);
    const conv = await withTenant(visitorDb, v.t, (tx) => createConversation(tx, v.t, v.v));
    await notify([channels.inbox(v.t)], {
      type: 'conversation',
      conversation: toSummary(conv, null),
    });
    return reply.code(201).send(CreateConversationResponse.parse({ conversationId: conv.id }));
  });

  app.post<{ Params: { id: string } }>(
    '/widget/v1/conversations/:id/messages',
    async (req, reply) => {
      const v = visitorFrom(req, reply);
      const body = SendMessageBody.parse(req.body);
      const conversationId = req.params.id;
      if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new NotFoundError();
      const result = await withTenant(visitorDb, v.t, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: v.t,
          conversationId,
          visitorId: v.v,
          text: body.text,
          clientMessageId: body.clientMessageId,
        }),
      );
      const message = toMessage(result.message);
      if (result.created) {
        await notify([channels.conversation(v.t, conversationId), channels.inbox(v.t)], {
          type: 'message',
          message,
        });
        await notify([channels.inbox(v.t)], {
          type: 'conversation',
          conversation: toSummary(result.conversation, message.body),
        });
      }
      return reply.code(result.created ? 201 : 200).send(SendMessageResponse.parse({ message }));
    },
  );

  // ---- Dashboard API (dashboard trust zone) -------------------------------------------
  const { sessionFrom } = registerAuth(app, deps);

  app.get('/api/v1/conversations', async (req) => {
    const s = await sessionFrom(req);
    const conversations = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listConversations(tx, s.tenantId),
    );
    return ConversationList.parse({ conversations });
  });

  registerFactRoutes(app, deps, sessionFrom);
  registerReviewRoutes(app, deps, sessionFrom);
  registerConflictRoutes(app, deps, sessionFrom);
  registerSourceRoutes(app, deps, sessionFrom, { resolve: deps.resolve });
  registerSettingsRoutes(app, deps, sessionFrom);

  return app;
}
