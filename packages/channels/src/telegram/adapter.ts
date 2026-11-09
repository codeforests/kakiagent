/**
 * The Telegram `ChannelAdapter` (ADR-011; FEAT-037 §5.1). The production inbound path is
 * `receiveTelegram` (the api's hook route, which checks the secret by hash, D3); this adapter
 * is the same parsing behind the contract every channel passes, plus `send` (the
 * `ChannelSender` binds it) and `checkHealth`, which the health job calls.
 */
import type { SecretSealer } from '@kaki/platform/secrets';
import type {
  ChannelAdapter,
  CredentialRef,
  HealthStatus,
  IgnoreReason,
  InboundEvent,
  OutboundMessage,
  RawInbound,
  Rejection,
  SendContext,
  SendResult,
  VerifiedInbound,
} from '../adapter.js';
import { TelegramApiError, telegramApi, type TelegramApi, type TelegramApiOptions } from './api.js';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import { openTelegram, secretHash, secretMatches } from './credential.js';
import { telegramIgnoreReason } from './ignore.js';
import { normaliseUpdate, telegramOf } from './parse.js';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export interface TelegramAdapterDeps {
  sealer: SecretSealer;
  /** `PUBLIC_HOOKS_URL/hooks/telegram/<connection id>`. */
  hookUrl(connectionId: string): string;
  api?: TelegramApiOptions | undefined;
  /** Tests swap the client. */
  client?: ((token: string) => TelegramApi) | undefined;
}

/** A failed call as the adapter contract's `SendResult`. */
export function sendFailure(e: unknown): Extract<SendResult, { ok: false }> {
  if (e instanceof TelegramApiError)
    return {
      ok: false,
      failed: e.failure.failed,
      status: e.failure.status,
      ...(e.failure.blocked ? { reason: 'blocked' as const } : {}),
      ...(e.failure.retryAfter ? { retryAfterSeconds: e.failure.retryAfter } : {}),
    };
  return { ok: false, failed: 'transient' };
}

/** Recent sends by message ID, so a repeated `send` in this process delivers once. */
const SENT_MEMO = 1000;

export function telegramAdapter(deps: TelegramAdapterDeps): ChannelAdapter {
  const client = deps.client ?? ((token: string) => telegramApi(token, deps.api));
  const sent = new Map<string, SendResult>();

  async function apiFor(creds: CredentialRef) {
    const c = await openTelegram(deps.sealer, creds);
    return { api: client(c.token), cred: c };
  }

  return {
    kind: 'telegram',
    capabilities: TELEGRAM_CAPABILITIES,
    async verifyInbound(
      req: RawInbound,
      creds: CredentialRef,
    ): Promise<VerifiedInbound | Rejection> {
      let cred;
      try {
        cred = await openTelegram(deps.sealer, creds);
      } catch {
        return { rejected: 'unknown_connection' };
      }
      if (!secretMatches(req.headers[SECRET_HEADER], secretHash(cred.webhookSecret)))
        return { rejected: 'bad_signature' };
      let body: unknown;
      try {
        body = JSON.parse(req.body);
      } catch {
        return { rejected: 'malformed' };
      }
      const id = (body as { update_id?: unknown }).update_id;
      if (typeof id !== 'number') return { rejected: 'malformed' };
      return { providerEventId: String(id), payload: body, receivedAt: req.receivedAt };
    },
    async normalise(v: VerifiedInbound, creds: CredentialRef): Promise<InboundEvent[]> {
      const e = normaliseUpdate(v.payload, {
        tenantId: creds.tenantId,
        connectionId: creds.connectionId,
      });
      return e ? [e] : [];
    },
    shouldIgnore: (e: InboundEvent): IgnoreReason | null => telegramIgnoreReason(e),
    threadKey: (e: InboundEvent) => String(telegramOf(e).chatId),
    async send(msg: OutboundMessage, ctx: SendContext): Promise<SendResult> {
      const done = sent.get(msg.id);
      if (done) return done;
      try {
        const { api } = await apiFor(ctx.credential);
        const id = await api.sendMessage(Number(ctx.threadKey), msg.text);
        const result: SendResult = { ok: true, externalId: String(id) };
        sent.set(msg.id, result);
        if (sent.size > SENT_MEMO) sent.delete(sent.keys().next().value!);
        return result;
      } catch (e) {
        return sendFailure(e);
      }
    },
    async checkHealth(creds: CredentialRef): Promise<HealthStatus> {
      let api: TelegramApi;
      let cred;
      try {
        ({ api, cred } = await apiFor(creds));
      } catch {
        return { ok: false, reason: 'credential_invalid' };
      }
      try {
        await api.getMe();
        const info = await api.getWebhookInfo();
        const ours = deps.hookUrl(creds.connectionId);
        if (!info.url) {
          // A webhook that never registered (or was deleted): register it again (§5.2).
          await api.setWebhook({ url: ours, secretToken: cred.webhookSecret });
          return { ok: true };
        }
        // Someone pointed the bot elsewhere: report it, never take it back (D6).
        return info.url === ours ? { ok: true } : { ok: false, reason: 'credential_invalid' };
      } catch (e) {
        if (e instanceof TelegramApiError && e.failure.failed === 'auth')
          return { ok: false, reason: 'credential_revoked' };
        return { ok: false, reason: 'unreachable' };
      }
    },
  };
}
