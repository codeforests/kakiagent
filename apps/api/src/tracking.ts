/**
 * First-party page tracking (CHN-03, UC-20 1a; FEAT-029 §3, §5.3, §5.4): the widget's events
 * beacon and the consent-mode choice. Visitor zone; the tenant comes from the verified token.
 */
import { NotConsentModeError, recordChoice, recordEvents } from '@kaki/channels/tracking';
import { TrackBody, TrackingChoiceBody } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { TokenError, verifyToken } from '@kaki/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App, Deps } from './server.js';

/** 120 events per visitor per 10 minutes (design §3). */
export const TRACK_LIMIT = { events: 120, windowMs: 10 * 60_000 };
export const TRACK_BODY_LIMIT = 16 * 1024;

type VisitorClaims = { t: string; o: string; v: string; exp: number };

export function registerTrackingRoutes(
  app: App,
  deps: Deps,
  visitorFrom: (req: FastifyRequest, reply: FastifyReply) => VisitorClaims,
): void {
  const { config, visitorDb, rateLimiter } = deps;

  // `sendBeacon` posts `text/plain` (no preflight) and can't set headers: the token is in the
  // body and checked against the Origin like `visitorFrom` (D8).
  app.post('/widget/v1/events', { bodyLimit: TRACK_BODY_LIMIT }, async (req, reply) => {
    let raw: unknown = req.body;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
      }
    }
    const parsed = TrackBody.safeParse(raw);
    if (!parsed.success)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    const claims = verifyToken<VisitorClaims>(parsed.data.token, config.VISITOR_TOKEN_SECRET);
    if (req.headers.origin !== claims.o) throw new TokenError('origin mismatch');
    reply.header('access-control-allow-origin', claims.o).header('vary', 'origin');
    const key = `track:${claims.t}:${claims.v}`;
    let allowed = true;
    try {
      for (let i = 0; i < parsed.data.events.length && allowed; i++)
        allowed = (await rateLimiter.hit(key, TRACK_LIMIT.events, TRACK_LIMIT.windowMs)).allowed;
    } catch (err) {
      // Analytics are best effort: without the limiter, drop the batch rather than fail the page.
      req.log.warn({ err }, 'rate limiter unavailable; tracking batch dropped');
      return reply.code(204).send();
    }
    if (!allowed)
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many events' });
    await withTenant(visitorDb, claims.t, (tx) =>
      recordEvents(tx, { tenantId: claims.t, visitorId: claims.v, events: parsed.data.events }),
    );
    return reply.code(204).send();
  });

  app.post('/widget/v1/tracking-choice', async (req, reply) => {
    const v = visitorFrom(req, reply);
    const parsed = TrackingChoiceBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    try {
      await withTenant(visitorDb, v.t, (tx) =>
        recordChoice(tx, { tenantId: v.t, visitorId: v.v, choice: parsed.data.choice }),
      );
    } catch (err) {
      if (err instanceof NotConsentModeError)
        return reply
          .code(409)
          .send({ error: 'not_consent_mode', message: 'Page sharing is not asked here.' });
      throw err;
    }
    return reply.code(204).send();
  });
}
