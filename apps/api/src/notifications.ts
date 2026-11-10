import {
  AlertEvent as AlertEventShape,
  NotificationPrefs,
  NotificationPrefsBody,
  TelegramAlertLink,
  TelegramLinkStart,
  TestAlertResult,
  type AlertEvent,
} from '@kaki/contracts';
import { codeHash, linkPending, queueServiceReply } from '@kaki/channels';
import { sql, withMember, type Tx } from '@kaki/db';
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
import { randomBytes, randomUUID } from 'node:crypto';
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
/** 409 `no_bot`: the business has no Telegram bot to link (FEAT-037 §3). */
export class NoTelegramBot extends Error {}

/** A link code lasts 15 minutes (D1). */
export const LINK_CODE_TTL_MS = 15 * 60_000;
const ALERTS_STOPPED = 'Alerts stopped. Link Telegram again in KakiAgent.';

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
  if (err instanceof NoTelegramBot)
    return {
      status: 409,
      body: { error: 'no_bot', message: 'Connect a Telegram bot first, on the Channels page' },
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

/** The business's bot (any state), or null: no Telegram column (FEAT-037 §5.5). */
async function botOf(tx: Tx): Promise<{ connectionId: string; username: string } | null> {
  const { rows } = await tx.execute<{ connection_id: string; bot_username: string }>(
    sql`select connection_id, bot_username from telegram_settings`,
  );
  return rows[0] ? { connectionId: rows[0].connection_id, username: rows[0].bot_username } : null;
}

/** The signed-in member's own link (the dashboard sees only its own row, AC-7). */
async function linkOf(tx: Tx, now: Date): Promise<TelegramAlertLink> {
  const { rows } = await tx.execute<{
    chat_id: string | null;
    telegram_name: string | null;
    linked_at: Date | null;
    code_expires_at: Date | null;
  }>(sql`select chat_id, telegram_name, linked_at, code_expires_at from telegram_alert_links`);
  const r = rows[0];
  if (r?.chat_id != null && r.linked_at)
    return {
      state: 'linked',
      name: r.telegram_name,
      linkedAt: new Date(r.linked_at).toISOString(),
    };
  const codeExpiresAt = r?.code_expires_at ? new Date(r.code_expires_at) : null;
  return {
    state: r && linkPending({ codeExpiresAt }, now) ? 'pending' : 'not_linked',
    name: null,
    linkedAt: null,
  };
}

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

  /** Prefs, the bot and the member's link in one dashboard-zone transaction. */
  const readAll = (s: TenantSession, fn?: (tx: Tx) => Promise<Prefs>) =>
    withMember(dashboardDb, s.tenantId, s.userId, async (tx) => {
      const prefs = fn ? await fn(tx) : await getPrefs(tx, s.tenantId, s.userId);
      const bot = await botOf(tx);
      return { prefs, telegram: bot ? await linkOf(tx, new Date()) : null };
    });

  async function view(
    s: TenantSession,
    { prefs, telegram }: { prefs: Prefs; telegram: TelegramAlertLink | null },
  ) {
    return NotificationPrefs.parse({
      channels: telegram ? ['email', 'telegram'] : ['email'],
      events: eventsFor(s).map((event) => ({
        event,
        email: !prefs.emailMuted.includes(event),
        ...(telegram ? { telegram: !prefs.telegramMuted.includes(event) } : {}),
      })),
      quietHours: {
        enabled: prefs.quiet.enabled,
        start: toClock(prefs.quiet.start),
        end: toClock(prefs.quiet.end),
      },
      timeZone: TIME_ZONE,
      sendTo: { email: await emailOf(s.userId), telegram },
    });
  }

  app.get('/api/v1/me/notifications', async (req) => {
    const s = await sessionFrom(req);
    return view(s, await readAll(s));
  });

  app.put('/api/v1/me/notifications', async (req) => {
    const s = await sessionFrom(req);
    const parsed = NotificationPrefsBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new NotificationPrefsBodyError(fieldsOf(parsed.error));
    const body = parsed.data;
    if (body.events.some((e) => !eventsFor(s).includes(e.event)))
      throw new ApprovalAlertsForbidden();
    const saved = await readAll(s, (tx) =>
      savePrefs(tx, s.tenantId, s.userId, {
        events: body.events,
        quiet: {
          enabled: body.quietHours.enabled,
          start: fromClock(body.quietHours.start),
          end: fromClock(body.quietHours.end),
        },
      }),
    );
    return view(s, saved);
  });

  // Link Telegram for alerts (FEAT-037 D1): a one-time `t.me/<bot>?start=<code>` link, hashed
  // at rest; a new code replaces an older one. The bot's webhook links the chat (§5.3).
  app.post('/api/v1/me/notifications/telegram/link', async (req, reply) => {
    const s = await sessionFrom(req);
    const code = `link-${randomBytes(16).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    const bot = await withMember(dashboardDb, s.tenantId, s.userId, async (tx) => {
      const b = await botOf(tx);
      if (!b) return null;
      await tx.execute(
        sql`insert into telegram_alert_links (tenant_id, user_id, code_hash, code_expires_at)
            values (${s.tenantId}, ${s.userId}, ${codeHash(code)}, ${expiresAt})
            on conflict (tenant_id, user_id) do update
              set code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at`,
      );
      return b;
    });
    if (!bot) throw new NoTelegramBot();
    return reply.code(201).send(
      TelegramLinkStart.parse({
        url: `https://t.me/${bot.username}?start=${code}`,
        expiresAt: expiresAt.toISOString(),
      }),
    );
  });

  // Unlink (FEAT-037 §3): the member stops getting Telegram alerts; the bot says so in the chat.
  app.delete('/api/v1/me/notifications/telegram', async (req, reply) => {
    const s = await sessionFrom(req);
    await withMember(dashboardDb, s.tenantId, s.userId, async (tx) => {
      const { rows } = await tx.execute<{ chat_id: string | null }>(
        sql`delete from telegram_alert_links where tenant_id = ${s.tenantId}
              and user_id = ${s.userId} returning chat_id`,
      );
      const chatId = rows[0]?.chat_id;
      const bot = chatId != null ? await botOf(tx) : null;
      if (bot && chatId != null)
        await queueServiceReply(tx, {
          tenantId: s.tenantId,
          connectionId: bot.connectionId,
          chatId: Number(chatId),
          text: ALERTS_STOPPED,
        });
    });
    return reply.code(204).send();
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
    // One row per channel (D8); `telegram` says whether the member's linked chat gets it too.
    const linked = await withMember(dashboardDb, s.tenantId, s.userId, async (tx) => {
      await notify(tx, {
        tenantId: s.tenantId,
        kind: 'test',
        recipients: [s.userId],
        urgent: true,
        subject: { type: 'user', id: s.userId },
        dedupeKey: `test:${randomUUID()}`,
      });
      return (await botOf(tx)) !== null && (await linkOf(tx, new Date())).state === 'linked';
    });
    return reply
      .code(202)
      .send(TestAlertResult.parse({ sentTo: await emailOf(s.userId), telegram: linked }));
  });
}
