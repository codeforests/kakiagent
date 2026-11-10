/**
 * Alerts on Telegram (LED-04; FEAT-037 §5.5, D1, D8, D9): the `TelegramAlertSender` port the
 * scheduler gives platform's alert sender. In its own visitor-zone transaction it reads the
 * member's linked chat and the business bot's sealed credential, so the identity zone never
 * sees a bot token. A member who blocked the bot is unlinked (`no_channel` from then on); a
 * revoked token degrades the channel and is retried like any failed alert.
 */
import { and, eq, schema, sql, withTenant, type ZoneDb } from '@kaki/db';
import type { TelegramAlertOutcome, TelegramAlertSender } from '@kaki/platform/notifications';
import type { SecretSealer } from '@kaki/platform/secrets';
import { reportSendFailure } from '../connections.js';
import { TelegramApiError, telegramApi, type TelegramApiOptions } from './api.js';
import { openTelegram } from './credential.js';

const { telegramSettings: ts, telegramAlertLinks: links } = schema;

export interface TelegramAlertsDeps {
  /** The visitor zone. */
  zdb: ZoneDb;
  sealer: SecretSealer;
  api?: TelegramApiOptions | undefined;
}

export function telegramAlerts(deps: TelegramAlertsDeps): TelegramAlertSender {
  return {
    async send({ tenantId, userId, text }): Promise<TelegramAlertOutcome> {
      const target = await withTenant(deps.zdb, tenantId, async (tx) => {
        const [row] = await tx
          .select({ connectionId: ts.connectionId, chatId: links.chatId })
          .from(links)
          .innerJoin(ts, eq(ts.tenantId, links.tenantId))
          .where(
            and(
              eq(links.tenantId, tenantId),
              eq(links.userId, userId),
              sql`${links.chatId} is not null`,
            ),
          )
          .limit(1);
        if (!row?.chatId) return null;
        const { rows } = await tx.execute<{ ciphertext: Buffer; key_ref: string }>(
          sql`select ciphertext, key_ref from channel_credential(${row.connectionId})`,
        );
        return rows[0] ? { ...row, chatId: row.chatId, cred: rows[0] } : null;
      });
      if (!target) return 'no_channel';
      const cred = await openTelegram(deps.sealer, {
        connectionId: target.connectionId,
        tenantId,
        ciphertext: target.cred.ciphertext,
        keyRef: target.cred.key_ref,
      });
      try {
        await telegramApi(cred.token, deps.api).sendMessage(target.chatId, text);
        return 'sent';
      } catch (e) {
        const failure =
          e instanceof TelegramApiError ? e.failure : { failed: 'transient' as const };
        if (failure.failed === 'auth') {
          await withTenant(deps.zdb, tenantId, (tx) =>
            reportSendFailure(tx, target.connectionId, { ok: false, failed: 'auth' }),
          );
          return { failed: 'auth' };
        }
        if (failure.failed === 'permanent') {
          // Blocked (or the chat is gone): stop sending there; the page shows "Not linked".
          if ('blocked' in failure && failure.blocked)
            await withTenant(deps.zdb, tenantId, (tx) =>
              tx
                .delete(links)
                .where(
                  and(
                    eq(links.tenantId, tenantId),
                    eq(links.userId, userId),
                    eq(links.chatId, target.chatId),
                  ),
                ),
            );
          return 'no_channel';
        }
        return { failed: 'transient' };
      }
    },
  };
}
