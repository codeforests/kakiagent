import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { RealtimeEvent } from '@kaki/contracts';
import { ping, withTenant, type ZoneDb } from '@kaki/db';
import { DEV_SESSION_COOKIE, readDevSession } from '@kaki/identity';
import { messagesSince, NotFoundError, toMessage } from '@kaki/inbox';
import { channels, TokenError, verifyToken, type Logger, type Subscriber } from '@kaki/platform';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';

export interface Deps {
  config: Config;
  logger: Logger;
  dashboardDb: ZoneDb;
  visitorDb: ZoneDb;
  subscriber: Subscriber;
}

interface VisitorClaims {
  t: string;
  o: string;
  v: string;
  exp: number;
}

const StreamQuery = z.object({
  token: z.string(),
  after: z.coerce.number().int().min(0).optional(),
});

/**
 * The realtime role (ADR-017): holds SSE streams for the widget and WebSockets for the
 * dashboard. It is stateless: durability comes from Postgres, Valkey only notifies,
 * and every (re)connect replays from the database by sequence number.
 */
export async function buildApp(deps: Deps) {
  const { config, subscriber } = deps;
  const app = Fastify({ loggerInstance: deps.logger, trustProxy: true });
  await app.register(cookie);
  await app.register(websocket);

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await Promise.all([
      ping(deps.dashboardDb),
      ping(deps.visitorDb),
      subscriber.ping(),
    ]).then(
      (r) => r.every(Boolean),
      () => false,
    );
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });

  // ---- Widget: Server-Sent Events --------------------------------------------------
  // EventSource can't set headers, so the visitor token travels in the query string;
  // it is short-lived and bound to tenant, origin and visitor (ADR-016).
  app.get<{ Params: { id: string } }>('/widget/v1/conversations/:id/stream', async (req, reply) => {
    const parsed = StreamQuery.safeParse(req.query);
    const conversationId = req.params.id;
    let claims: VisitorClaims;
    try {
      if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(conversationId))
        throw new TokenError('bad request');
      claims = verifyToken<VisitorClaims>(parsed.data.token, config.VISITOR_TOKEN_SECRET);
      if (req.headers.origin && req.headers.origin !== claims.o)
        throw new TokenError('origin mismatch');
    } catch {
      return reply.code(401).send({ error: 'unauthorized', message: 'Reconnect the chat' });
    }
    const lastEventId = Number(req.headers['last-event-id'] ?? parsed.data.after ?? 0) || 0;

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': claims.o,
      vary: 'origin',
    });
    raw.write('retry: 3000\n\n');

    let lastSent = lastEventId;
    const send = (seq: number, event: unknown) => {
      if (seq <= lastSent) return;
      lastSent = seq;
      raw.write(`id: ${seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe first, then replay, so nothing committed in between is missed; `send`
    // drops anything already delivered.
    const buffered: { seq: number; event: unknown }[] = [];
    let replaying = true;
    const unsubscribe = await subscriber.subscribe(
      channels.conversation(claims.t, conversationId),
      (e) => {
        const parsedEvent = RealtimeEvent.safeParse(e);
        if (!parsedEvent.success || parsedEvent.data.type !== 'message') return;
        const item = { seq: parsedEvent.data.message.seq, event: parsedEvent.data };
        if (replaying) buffered.push(item);
        else send(item.seq, item.event);
      },
    );
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), config.SSE_HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      void unsubscribe();
    });

    try {
      const missed = await withTenant(deps.visitorDb, claims.t, (tx) =>
        messagesSince(tx, {
          tenantId: claims.t,
          conversationId,
          afterSeq: lastEventId,
          visitorId: claims.v,
        }),
      );
      for (const m of missed) send(m.seq, { type: 'message', message: toMessage(m) });
    } catch (err) {
      if (!(err instanceof NotFoundError)) req.log.error({ err }, 'sse replay failed');
      clearInterval(heartbeat);
      await unsubscribe();
      raw.end();
      return;
    }
    replaying = false;
    for (const b of buffered.sort((a, z2) => a.seq - z2.seq)) send(b.seq, b.event);
  });

  // ---- Dashboard: WebSocket --------------------------------------------------------
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const session = readDevSession(req.cookies[DEV_SESSION_COOKIE], config.SESSION_SECRET);
    if (!session) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const unsubscribe = await subscriber.subscribe(channels.inbox(session.tenantId), (e) => {
      const parsedEvent = RealtimeEvent.safeParse(e);
      if (parsedEvent.success && socket.readyState === socket.OPEN)
        socket.send(JSON.stringify(parsedEvent.data));
    });
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('close', () => void unsubscribe());
  });

  return app;
}
