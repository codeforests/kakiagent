import {
  AlertEvent as AlertEventShape,
  NotificationPrefs,
  NotificationPrefsBody,
  TestAlertResult,
  type AlertEvent,
} from '@kaki/contracts';
import { sql, withTenant } from '@kaki/db';
import { can, canApprove } from '@kaki/identity';
import {
  fromClock,
  getPrefs,
  notify,
  savePrefs,
  TIME_ZONE,
  toClock,
  type Prefs,
} from '@kaki/platform/notifications';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ZodError } from 'zod';
import { UnavailableError, type TenantSession } from './auth.js';
import type { App, Deps } from './server.js';

/** One test alert a minute per member (D11). */
const TEST_WINDOW_MS = 60_000;

/** 422 `invalid_preferences` with a code per field path (`same_time`, `duplicate_event`). */
export class NotificationPrefsBodyError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid notification preferences');
  }
}
/** 403: approval alerts are only for members who can approve (D9). */
export class ApprovalAlertsForbidden extends Error {}
export class TestAlertRateLimited extends Error {}

function fieldsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || 'body';
    if (!out[path]) out[path] = issue.code === 'custom' ? issue.message : 'invalid';
  }
  return out;
}

export function notificationsErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof NotificationPrefsBodyError)
    return {
      status: 422,
      body: {
        error: 'invalid_preferences',
        message: 'Check the highlighted settings',
        fields: err.fields,
      },
    };
  if (err instanceof ApprovalAlertsForbidden)
    return {
      status: 403,
      body: { error: 'forbidden', message: "You can't receive approval alerts" },
    };
  if (err instanceof TestAlertRateLimited)
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: 'You sent a test alert a moment ago. Try again in a minute.',
        retryAfterSeconds: TEST_WINDOW_MS / 1000,
      },
    };
  return null;
}

/** The events this member can receive, in contract order (D9; FEAT-037 §3: channel alerts for settings.manage). */
const eventsFor = (s: TenantSession): AlertEvent[] =>
  AlertEventShape.options.filter(
    (e) =>
      (e !== 'approval_pending' || canApprove(s)) &&
      (e !== 'channel_degraded' || can(s.role, 'settings.manage')),
  );

/**
 * Notification preferences and the test alert (DSH-09, LED-04; FEAT-052 §5.4). Every route is
 * the caller's own: the tenant and user come from the session only, never the body.
 */
export function registerNotificationRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, identityDb, rateLimiter } = deps;

  async function emailOf(userId: string) {
    const { rows } = await identityDb.db.execute<{ email: string }>(
      sql`select email from users where id = ${userId}`,
    );
    return rows[0]?.email ?? '';
  }

  async function view(s: TenantSession, prefs: Prefs) {
    return NotificationPrefs.parse({
      channels: ['email'],
      events: eventsFor(s).map((event) => ({ event, email: !prefs.emailMuted.includes(event) })),
      quietHours: {
        enabled: prefs.quiet.enabled,
        start: toClock(prefs.quiet.start),
        end: toClock(prefs.quiet.end),
      },
      timeZone: TIME_ZONE,
      // FEAT-037 T7 fills the member's Telegram link.
      sendTo: { email: await emailOf(s.userId), telegram: null },
    });
  }

  app.get('/api/v1/me/notifications', async (req) => {
    const s = await sessionFrom(req);
    const prefs = await withTenant(dashboardDb, s.tenantId, (tx) =>
      getPrefs(tx, s.tenantId, s.userId),
    );
    return view(s, prefs);
  });

  app.put('/api/v1/me/notifications', async (req) => {
    const s = await sessionFrom(req);
    const parsed = NotificationPrefsBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new NotificationPrefsBodyError(fieldsOf(parsed.error));
    const body = parsed.data;
    if (body.events.some((e) => !eventsFor(s).includes(e.event)))
      throw new ApprovalAlertsForbidden();
    const prefs = await withTenant(dashboardDb, s.tenantId, (tx) =>
      savePrefs(tx, s.tenantId, s.userId, {
        events: body.events,
        quiet: {
          enabled: body.quietHours.enabled,
          start: fromClock(body.quietHours.start),
          end: fromClock(body.quietHours.end),
        },
      }),
    );
    return view(s, prefs);
  });

  app.post('/api/v1/me/notifications/test', async (req, reply) => {
    const s = await sessionFrom(req);
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(`notify-test:${s.userId}`, 1, TEST_WINDOW_MS)).allowed;
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new TestAlertRateLimited();
    await withTenant(dashboardDb, s.tenantId, (tx) =>
      notify(tx, {
        tenantId: s.tenantId,
        kind: 'test',
        recipients: [s.userId],
        urgent: true,
        subject: { type: 'user', id: s.userId },
        dedupeKey: `test:${randomUUID()}`,
      }),
    );
    return reply
      .code(202)
      .send(TestAlertResult.parse({ sentTo: await emailOf(s.userId), telegram: false }));
  });
}
