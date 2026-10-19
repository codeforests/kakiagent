import cookie from '@fastify/cookie';
import { isAllowedOrigin } from '@kaki/channels';
import {
  ConversationList,
  CreateConversationResponse,
  Me,
  SendMessageBody,
  SendMessageResponse,
  WidgetConfigQuery,
  WidgetConfigResponse,
  type RealtimeEvent,
} from '@kaki/contracts';
import { eq, ping, schema, withTenant } from '@kaki/db';
import { DEV_SESSION_COOKIE, readDevSession, type DevSession } from '@kaki/identity';
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
  InvalidStateError,
  VersionConflictError,
} from '@kaki/kb';
import { channels, signToken, TokenError, verifyToken } from '@kaki/platform';
import { resolveWidgetKey } from '@kaki/tenancy';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { FactNotFound, ForbiddenError, registerFactRoutes } from './facts.js';
import { createServer, type Deps } from './server.js';

export type { App, Deps } from './server.js';

/** Signed widget visitor token claims (ADR-016 decision 6): tenant, origin and visitor are bound. */
interface VisitorClaims {
  t: string;
  o: string;
  v: string;
  exp: number;
}

const VISITOR_TOKEN_TTL_S = 3600;

export async function buildApp(deps: Deps) {
  const { config, dashboardDb, visitorDb, publisher } = deps;
  const app = createServer(deps.logger);
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    if (
      err instanceof NotFoundError ||
      err instanceof FactNotFoundError ||
      err instanceof FactNotFound
    )
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (err instanceof TokenError)
      return reply.code(401).send({ error: 'unauthorized', message: 'Sign in again' });
    if (err instanceof ForbiddenError)
      return reply.code(403).send({ error: 'forbidden', message: 'Not allowed' });
    if (err instanceof VersionConflictError)
      return reply
        .code(409)
        .send({ error: 'version_conflict', message: 'This fact was changed by someone else' });
    if (err instanceof InvalidStateError)
      return reply.code(409).send({ error: 'invalid_state', message: err.message });
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
    reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    return WidgetConfigResponse.parse({
      token,
      visitorId,
      realtimeUrl: config.PUBLIC_REALTIME_URL,
      panelUrl: config.PUBLIC_WIDGET_PANEL_URL,
      botName: 'Assistant',
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
  function sessionFrom(req: FastifyRequest): DevSession {
    const session = readDevSession(req.cookies[DEV_SESSION_COOKIE], config.SESSION_SECRET);
    if (!session) throw new TokenError('no session');
    return session;
  }

  app.get('/api/v1/me', async (req) => {
    const s = sessionFrom(req);
    const [tenant] = await withTenant(dashboardDb, s.tenantId, (tx) =>
      tx.select().from(schema.tenants).where(eq(schema.tenants.id, s.tenantId)),
    );
    if (!tenant) throw new TokenError('tenant gone');
    return Me.parse({
      userId: s.userId,
      role: s.role,
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
    });
  });

  app.get('/api/v1/conversations', async (req) => {
    const s = sessionFrom(req);
    const conversations = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listConversations(tx, s.tenantId),
    );
    return ConversationList.parse({ conversations });
  });

  registerFactRoutes(app, deps, sessionFrom);

  // Dev-only sign-in. `process.env.KAKI_BUILD` is replaced with "production" by the
  // bundler, which makes this branch dead code and drops the module (plan §2).
  if (process.env.KAKI_BUILD !== 'production' && config.KAKI_DEV_AUTH === 'true') {
    const { registerDevAuth } = await import('./dev-auth.js');
    registerDevAuth(app, deps);
  }

  return app;
}
