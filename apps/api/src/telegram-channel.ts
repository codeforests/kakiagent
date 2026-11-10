/**
 * The Telegram channel (CHN-05, CHN-12, CHN-01; FEAT-037 §3): the generic webhook route
 * `/hooks/:kind/:connectionId` (ADR-011), which runs the registry entry's `hook`, and the
 * dashboard routes that connect, replace and disconnect the bot.
 */
import { DEFAULT_GREETING, textsFor } from '@kaki/agent';
import {
  connectTelegram,
  disconnectTelegram,
  receiveTelegram,
  registryEntry,
  replaceTelegramToken,
  SECRET_HEADER,
  TelegramChannelError,
  telegramChannelView,
  type TelegramApiOptions,
  type TelegramChannelErrorCode,
  type TelegramSettingsDeps,
  type TelegramTexts,
} from '@kaki/channels';
import {
  TelegramChannelResponse,
  TelegramConnectBody,
  TelegramDisconnectBody,
  TelegramReplaceBody,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { visitorPrivacy } from '@kaki/governance';
import * as inbox from '@kaki/inbox';
import { channels } from '@kaki/platform';
import { localSealer, type SecretSealer } from '@kaki/platform/secrets';
import { visitorTenantState } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const HookParams = z.object({ kind: z.string().max(32), connectionId: z.uuid() });

export function telegramApiOf(deps: Deps): TelegramApiOptions {
  return deps.telegram?.api ?? { base: deps.config.TELEGRAM_API_BASE };
}

export function channelSealerOf(deps: Deps): SecretSealer {
  return localSealer(Buffer.from(deps.config.CHANNEL_SECRET_KEY, 'base64url'));
}

export const hookUrlOf = (deps: Deps) => (connectionId: string) =>
  `${deps.config.PUBLIC_HOOKS_URL}/hooks/telegram/${connectionId}`;

/**
 * The `/start` greeting and the business name (FEAT-037 §5.3), in the visitor zone: the
 * greeting, the AI disclosure (AGT-11) and the privacy line (GOV-14, D7). As the email footer,
 * only the tenant's own notice link is shown (the hosted page needs the widget key).
 */
export async function telegramTexts(tx: Tx, lang: 'en' | 'zh'): Promise<TelegramTexts> {
  const [tenant, privacy] = await Promise.all([visitorTenantState(tx), visitorPrivacy(tx)]);
  const businessName = tenant?.businessName ?? privacy?.businessName ?? 'Our team';
  const persona = tenant?.persona;
  const t = textsFor(lang, persona);
  const notice = privacy?.notice ?? null;
  const privacyLine =
    notice?.mode === 'link' ? `${businessName} · Privacy notice: ${notice.url}` : businessName;
  const greeting = persona?.greeting[lang] ?? DEFAULT_GREETING[lang];
  return {
    businessName,
    greeting: [t.disclosure(businessName), greeting, privacyLine].join('\n\n'),
  };
}

/** `POST /hooks/:kind/:connectionId` (public; NFR-17: 200 only once stored or ignored). */
export function registerHookRoutes(app: App, deps: Deps): void {
  const { config, visitorDb, rateLimiter, publisher, logger } = deps;
  app.post('/hooks/:kind/:connectionId', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const params = HookParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const entry = registryEntry(params.data.kind);
    if (!entry?.hook) return reply.code(404).send({ error: 'not_found' });
    const { connectionId } = params.data;
    let allowed = true;
    try {
      allowed = (await rateLimiter.hit(`rl:hook:${connectionId}`, config.HOOK_RATE_LIMIT, 60_000))
        .allowed;
    } catch {
      allowed = true; // the limiter is a backstop; Telegram's own rate is far lower
    }
    if (!allowed) return reply.code(429).send({ error: 'rate_limited' });
    const header = req.headers[SECRET_HEADER];
    const r = await receiveTelegram(
      {
        zdb: visitorDb,
        inbox,
        texts: (tx, _tenantId, lang) => telegramTexts(tx, lang),
        appUrl: config.PUBLIC_APP_URL,
      },
      {
        connectionId,
        secretHeader: Array.isArray(header) ? header[0] : header,
        body: req.body,
      },
    );
    if (r.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (r.status === 401) {
      logger.warn({ connectionId }, 'telegram webhook with a wrong secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if ('message' in r && r.message && r.conversation) {
      // The inbox sees the new message live (pub/sub is best effort; Postgres is the record).
      const t = r.tenantId;
      const message = inbox.toMessage(r.message);
      await Promise.allSettled([
        publisher.publish(channels.conversation(t, r.conversation.id), {
          type: 'message',
          message,
        }),
        publisher.publish(channels.inbox(t), {
          type: 'conversation',
          conversation: inbox.toSummary(r.conversation, message.body),
        }),
      ]);
    }
    return reply.code(200).send({ ok: true });
  });
}

const ERRORS: Record<TelegramChannelErrorCode, [number, string]> = {
  invalid_format: [422, "That doesn't look like a bot token. Copy the whole token from BotFather."],
  token_rejected: [422, 'Telegram rejected this token. Check it in BotFather and try again.'],
  already_connected: [409, 'A Telegram bot is already connected.'],
  not_connected: [409, 'No Telegram bot is connected.'],
  bot_in_use: [409, 'This bot is connected to another business.'],
  different_bot: [422, 'This token is for a different bot. Use a new token for the same bot.'],
  provider_unavailable: [502, "Telegram didn't answer. Try again in a minute."],
  stale: [409, 'Someone else changed this channel. Reload to see the latest.'],
};

/** 422 `invalid_body`: the body isn't the route's shape (other than a bad token). */
export class TelegramBodyError extends Error {}

export function telegramErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof TelegramChannelError) {
    const [status, message] = ERRORS[err.code];
    return { status, body: { error: err.code, message } };
  }
  if (err instanceof TelegramBodyError)
    return {
      status: 422,
      body: { error: 'invalid_body', message: 'Check the values and try again.' },
    };
  return null;
}

export const telegramSettingsDepsOf = (deps: Deps): TelegramSettingsDeps => ({
  sealer: channelSealerOf(deps),
  hookUrl: hookUrlOf(deps),
  api: telegramApiOf(deps),
});

/** Only the token's format is the token's error (`invalid_format`); the rest is `invalid_body`. */
function bodyOf<T>(shape: ZodType<T>, body: unknown): T {
  const parsed = shape.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.every((i) => i.path[0] === 'token'))
    throw new TelegramChannelError('invalid_format');
  throw new TelegramBodyError();
}

/**
 * `GET`/`POST /api/v1/channels/telegram`, `PUT …/token`, `DELETE` (CHN-05, CHN-12; FEAT-037
 * §3, §5.2): `settings.manage` (Owner, Admin); the tenant from the session, never the body.
 * Telegram calls run between transactions (`@kaki/channels` telegram settings).
 */
export function registerTelegramChannelRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
): void {
  const { dashboardDb } = deps;
  const tg = telegramSettingsDepsOf(deps);
  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'settings.manage')) throw new ForbiddenError('settings.manage');
    return s;
  }
  const view = (s: TenantSession) =>
    withTenant(dashboardDb, s.tenantId, (tx) => telegramChannelView(tx, s.tenantId)).then((r) =>
      TelegramChannelResponse.parse(r),
    );

  app.get('/api/v1/channels/telegram', async (req) => view(await manager(req)));

  app.post('/api/v1/channels/telegram', async (req, reply) => {
    const s = await manager(req);
    const body = bodyOf(TelegramConnectBody, req.body);
    await connectTelegram(dashboardDb, tg, {
      tenantId: s.tenantId,
      userId: s.userId,
      token: body.token,
    });
    return reply.code(201).send(await view(s));
  });

  app.put('/api/v1/channels/telegram/token', async (req) => {
    const s = await manager(req);
    const body = bodyOf(TelegramReplaceBody, req.body);
    await replaceTelegramToken(dashboardDb, tg, {
      tenantId: s.tenantId,
      userId: s.userId,
      token: body.token,
      settingsVersion: body.settingsVersion,
    });
    return view(s);
  });

  app.delete('/api/v1/channels/telegram', async (req) => {
    const s = await manager(req);
    const body = bodyOf(TelegramDisconnectBody, req.body);
    await disconnectTelegram(dashboardDb, tg, {
      tenantId: s.tenantId,
      userId: s.userId,
      settingsVersion: body.settingsVersion,
    });
    return view(s);
  });
}
