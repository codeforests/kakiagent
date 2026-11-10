/**
 * Service replies (FEAT-037 §5.3 step 3): a `channel-send` job of `type: 'service'` is a bot
 * message that isn't a conversation message (the group notice, then leave; link
 * confirmations; the `/start` greeting). Sent outside any transaction; a transient failure is
 * retried by the queue until 24 hours after it was queued, then dropped (nothing for staff to
 * retry). A revoked token degrades the channel, as a send does.
 */
import { sql, withTenant, type ZoneDb } from '@kaki/db';
import type { ChannelServiceJob } from '@kaki/contracts';
import type { SecretSealer } from '@kaki/platform/secrets';
import { reportSendFailure } from '../connections.js';
import { TelegramApiError, telegramApi, type TelegramApiOptions } from './api.js';
import { openTelegram } from './credential.js';

export const SERVICE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export interface TelegramServiceDeps {
  /** The visitor zone. */
  zdb: ZoneDb;
  sealer: SecretSealer;
  api?: TelegramApiOptions | undefined;
  now?: () => Date;
}

export class ServiceRetryError extends Error {}

export type ServiceOutcome = 'sent' | 'dropped';

export async function sendServiceJob(
  deps: TelegramServiceDeps,
  job: ChannelServiceJob,
): Promise<ServiceOutcome> {
  const now = deps.now?.() ?? new Date();
  const creds = await withTenant(deps.zdb, job.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ ciphertext: Buffer; key_ref: string }>(
      sql`select ciphertext, key_ref from channel_credential(${job.connectionId})`,
    );
    return rows[0];
  });
  // Disconnected since: nothing to send with.
  if (!creds) return 'dropped';
  const cred = await openTelegram(deps.sealer, {
    connectionId: job.connectionId,
    tenantId: job.tenantId,
    ciphertext: creds.ciphertext,
    keyRef: creds.key_ref,
  });
  const api = telegramApi(cred.token, deps.api);
  try {
    await api.sendMessage(job.chatId, job.text);
    if (job.leave) await api.leaveChat(job.chatId).catch(() => undefined);
    return 'sent';
  } catch (e) {
    const failure = e instanceof TelegramApiError ? e.failure : { failed: 'transient' as const };
    if (failure.failed === 'permanent') {
      if (job.leave) await api.leaveChat(job.chatId).catch(() => undefined);
      return 'dropped';
    }
    if (failure.failed === 'auth')
      await withTenant(deps.zdb, job.tenantId, (tx) =>
        reportSendFailure(tx, job.connectionId, { ok: false, failed: 'auth' }),
      );
    if (now.getTime() - new Date(job.queuedAt).getTime() >= SERVICE_GIVE_UP_MS) return 'dropped';
    throw new ServiceRetryError(`telegram service reply: ${failure.failed}`);
  }
}
