/**
 * The Telegram channel (CHN-05, CHN-12, CHN-01; FEAT-037 §3): the generic webhook route
 * `/hooks/:kind/:connectionId` (ADR-011), which runs the registry entry's `hook`, and the
 * dashboard routes that connect, replace and disconnect the bot.
 */
import { DEFAULT_GREETING, textsFor } from '@kaki/agent';
import {
  receiveTelegram,
  registryEntry,
  SECRET_HEADER,
  type TelegramApiOptions,
  type TelegramTexts,
} from '@kaki/channels';
import { type Tx } from '@kaki/db';
import { visitorPrivacy } from '@kaki/governance';
import * as inbox from '@kaki/inbox';
import { channels } from '@kaki/platform';
import { localSealer, type SecretSealer } from '@kaki/platform/secrets';
import { visitorTenantState } from '@kaki/tenancy';
import { z } from 'zod';
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
