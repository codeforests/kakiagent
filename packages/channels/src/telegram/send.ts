/**
 * The Telegram reply (CHN-05; FEAT-037 §5.4): `deliverMessage`'s `ChannelSender` for Telegram
 * conversations. The chat comes from `telegram_chats` (the conversation's latest chat), the
 * token from the sealed credential through `channel_credential()`. A chat that blocked the bot
 * fails `permanent`/`blocked` without a call; a revoked token is `auth` (degraded, retried).
 */
import { and, desc, eq, schema, sql, type Tx } from '@kaki/db';
import type { SecretSealer } from '@kaki/platform/secrets';
import type { ChannelSender } from '../deliver.js';
import { sendFailure } from './adapter.js';
import { telegramApi, type TelegramApiOptions } from './api.js';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import { openTelegram } from './credential.js';

const tc = schema.telegramChats;

export interface TelegramSenderConfig {
  sealer: SecretSealer;
  api?: TelegramApiOptions | undefined;
}

export function telegramSender(cfg: TelegramSenderConfig): ChannelSender {
  return {
    capabilities: TELEGRAM_CAPABILITIES,
    async send(tx: Tx, input) {
      const [chat] = await tx
        .select({ chatId: tc.chatId, blockedAt: tc.blockedAt })
        .from(tc)
        .where(and(eq(tc.tenantId, input.tenantId), eq(tc.conversationId, input.conversation.id)))
        .orderBy(desc(tc.lastInboundAt))
        .limit(1);
      if (!chat) return { ok: false, failed: 'permanent' };
      if (chat.blockedAt) return { ok: false, failed: 'permanent', status: 403, reason: 'blocked' };
      const { rows } = await tx.execute<{ ciphertext: Buffer; key_ref: string }>(
        sql`select ciphertext, key_ref from channel_credential(${input.connectionId})`,
      );
      // Disconnected since the reply was queued: nothing to send with. That's not a rejected
      // login, so the channel isn't degraded (the bot is gone); staff see it wasn't delivered.
      if (!rows[0]) return { ok: false, failed: 'permanent' };
      try {
        const cred = await openTelegram(cfg.sealer, {
          connectionId: input.connectionId,
          tenantId: input.tenantId,
          ciphertext: rows[0].ciphertext,
          keyRef: rows[0].key_ref,
        });
        const id = await telegramApi(cred.token, cfg.api).sendMessage(chat.chatId, input.text);
        return { ok: true, externalId: String(id) };
      } catch (e) {
        const failed = sendFailure(e);
        if (failed.reason === 'blocked')
          await tx
            .update(tc)
            .set({ blockedAt: new Date() })
            .where(and(eq(tc.tenantId, input.tenantId), eq(tc.chatId, chat.chatId)));
        return failed;
      }
    },
  };
}
