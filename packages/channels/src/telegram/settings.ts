/**
 * The Telegram channel's settings (CHN-05, CHN-12; FEAT-037 §5.2, SCR-APP-039): connect a
 * BotFather token, replace it with one for the same bot, disconnect. Dashboard zone. Bot API
 * calls happen between transactions, never inside one; the token is sealed with the webhook
 * secret (D3) and never returned, logged or audited.
 */
import { randomBytes } from 'node:crypto';
import type { TelegramChannelResponse, TelegramIgnoreReason } from '@kaki/contracts';
import { TelegramToken } from '@kaki/contracts';
import { and, desc, eq, gte, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { SecretSealer } from '@kaki/platform/secrets';
import type { CredentialRef } from '../adapter.js';
import { recordHealth, UNREACHABLE_LIMIT } from '../connections.js';
import { TelegramApiError, telegramApi, type TelegramApi, type TelegramApiOptions } from './api.js';
import { botIdOf, openTelegram, sealTelegram, secretHash } from './credential.js';

const { channelConnections: cc, telegramSettings: ts, inboundEvents: ie } = schema;
const IGNORED_DAYS = 7;

export type TelegramChannelErrorCode =
  | 'invalid_format'
  | 'token_rejected'
  | 'already_connected'
  | 'not_connected'
  | 'bot_in_use'
  | 'different_bot'
  | 'provider_unavailable'
  | 'stale';

export class TelegramChannelError extends Error {
  constructor(readonly code: TelegramChannelErrorCode) {
    super(code);
  }
}

export interface TelegramSettingsDeps {
  sealer: SecretSealer;
  /** `PUBLIC_HOOKS_URL/hooks/telegram/<connection id>`. */
  hookUrl(connectionId: string): string;
  api?: TelegramApiOptions | undefined;
}

const clientOf = (deps: TelegramSettingsDeps, token: string): TelegramApi =>
  telegramApi(token, deps.api);

/** The bot behind a token, or the 422/502 the routes answer. */
async function botOf(deps: TelegramSettingsDeps, raw: string) {
  const parsed = TelegramToken.safeParse(raw);
  if (!parsed.success) throw new TelegramChannelError('invalid_format');
  const token = parsed.data;
  try {
    const me = await clientOf(deps, token).getMe();
    if (me.id !== botIdOf(token) || !me.username) throw new TelegramChannelError('token_rejected');
    return { token, id: me.id, username: me.username, name: me.first_name || me.username };
  } catch (e) {
    if (e instanceof TelegramChannelError) throw e;
    if (e instanceof TelegramApiError && e.failure.failed === 'auth')
      throw new TelegramChannelError('token_rejected');
    throw new TelegramChannelError('provider_unavailable');
  }
}

const newSecret = () => randomBytes(32).toString('base64url');

const isUnique = (e: unknown, name: string) => {
  const err = e as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const c = err.cause ?? err;
  return c.code === '23505' && (c.constraint === name || !c.constraint);
};

/** The sealed credential through `channel_credential()` (the dashboard can't read the column). */
export async function telegramCredentialOf(tx: Tx, connectionId: string): Promise<CredentialRef> {
  const tenantId = (await tx.execute<{ t: string }>(sql`select app_current_tenant()::text as t`))
    .rows[0]!.t;
  const { rows } = await tx.execute<{ ciphertext: Buffer | null; key_ref: string | null }>(
    sql`select ciphertext, key_ref from channel_credential(${connectionId})`,
  );
  return {
    connectionId,
    tenantId,
    ciphertext: rows[0]?.ciphertext ?? null,
    keyRef: rows[0]?.key_ref ?? null,
  };
}

/** `GET /api/v1/channels/telegram`. */
export async function telegramChannelView(
  tx: Tx,
  tenantId: string,
): Promise<TelegramChannelResponse> {
  const [settings] = await tx.select().from(ts).where(eq(ts.tenantId, tenantId));
  const [conn] = settings
    ? await tx
        .select({
          id: cc.id,
          state: cc.state,
          health: cc.health,
          healthReason: cc.healthReason,
          version: cc.version,
        })
        .from(cc)
        .where(and(eq(cc.tenantId, tenantId), eq(cc.id, settings.connectionId)))
    : [];
  const since = new Date(Date.now() - IGNORED_DAYS * 24 * 60 * 60 * 1000);
  const ignored =
    settings && conn
      ? await tx
          .select({ reason: ie.ignoreReason, count: sql<number>`count(*)::int` })
          .from(ie)
          .where(
            and(
              eq(ie.tenantId, tenantId),
              eq(ie.connectionId, conn.id),
              eq(ie.outcome, 'ignored'),
              gte(ie.receivedAt, since),
            ),
          )
          .groupBy(ie.ignoreReason)
          .orderBy(desc(sql`count(*)`), ie.ignoreReason)
      : [];
  const members = settings
    ? (await tx.execute<{ n: number }>(sql`select telegram_alert_link_count() as n`)).rows[0]!.n
    : 0;
  const reasons = new Set<string>(['group', 'unsupported', 'staff_chat']);
  return {
    connected: !!settings && !!conn,
    connection: conn
      ? {
          id: conn.id,
          state: conn.state as 'live' | 'offline',
          health: conn.health as 'ok' | 'degraded' | 'unknown',
          healthReason: conn.healthReason,
          version: conn.version,
        }
      : null,
    bot: settings
      ? {
          id: String(settings.botId),
          username: settings.botUsername,
          name: settings.botName,
          link: `https://t.me/${settings.botUsername}`,
        }
      : null,
    lastReceivedAt: settings?.lastReceivedAt?.toISOString() ?? null,
    ignored: ignored
      .filter((r): r is { reason: TelegramIgnoreReason; count: number } =>
        reasons.has(r.reason ?? ''),
      )
      .map((r) => ({ reason: r.reason, count: Number(r.count) })),
    alertMembers: Number(members),
    settingsVersion: settings?.version ?? 0,
  };
}

/** After a commit: register the webhook; a failure leaves the channel degraded `unreachable`. */
async function registerWebhook(
  zdb: ZoneDb,
  deps: TelegramSettingsDeps,
  tenantId: string,
  connectionId: string,
  token: string,
  secret: string,
): Promise<void> {
  let ok = true;
  try {
    await clientOf(deps, token).setWebhook({
      url: deps.hookUrl(connectionId),
      secretToken: secret,
    });
  } catch {
    ok = false;
  }
  await withTenant(zdb, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: cc.id,
        tenantId: cc.tenantId,
        kind: cc.kind,
        health: cc.health,
        healthFailures: cc.healthFailures,
        degradedSince: cc.degradedSince,
      })
      .from(cc)
      .where(eq(cc.id, connectionId));
    if (!row) return;
    // "Check again" re-registers it; one failed registration is enough to show it (§5.2).
    await recordHealth(
      tx,
      ok ? row : { ...row, healthFailures: Math.max(row.healthFailures, UNREACHABLE_LIMIT - 1) },
      ok ? { ok: true } : { ok: false, reason: 'unreachable' },
    );
  });
}

/**
 * `POST /api/v1/channels/telegram` (UC-25 1–3): the connection offline and hidden (D4), the
 * bot's settings (one business per bot, D6), the sealed credential, then the webhook.
 */
export async function connectTelegram(
  zdb: ZoneDb,
  deps: TelegramSettingsDeps,
  input: { tenantId: string; userId: string; token: string },
): Promise<void> {
  const bot = await botOf(deps, input.token);
  const secret = newSecret();
  const connectionId = await withTenant(zdb, input.tenantId, async (tx) => {
    const [settings] = await tx
      .select({ t: ts.tenantId })
      .from(ts)
      .where(eq(ts.tenantId, input.tenantId));
    if (settings) throw new TelegramChannelError('already_connected');
    const [existing] = await tx
      .select({ id: cc.id })
      .from(cc)
      .where(and(eq(cc.tenantId, input.tenantId), eq(cc.kind, 'telegram')));
    let id = existing?.id;
    if (!id) {
      // Raw SQL: Drizzle names every column, and the dashboard may insert only these.
      const { rows } = await tx.execute<{ id: string }>(
        sql`insert into channel_connections (tenant_id, kind, state, offline_mode, health)
            values (${input.tenantId}, 'telegram', 'offline', 'hidden', 'unknown') returning id`,
      );
      id = rows[0]!.id;
    }
    const sealed = await sealTelegram(deps.sealer, id, { token: bot.token, webhookSecret: secret });
    const now = new Date();
    await tx
      .update(cc)
      .set({
        state: 'offline',
        offlineMode: 'hidden',
        health: 'unknown',
        healthReason: null,
        healthFailures: 0,
        degradedSince: null,
        credentialCiphertext: Buffer.from(sealed.ciphertext),
        credentialKeyRef: sealed.keyRef,
        updatedAt: now,
      })
      .where(eq(cc.id, id));
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(ts).values({
          tenantId: input.tenantId,
          connectionId: id,
          botId: bot.id,
          botUsername: bot.username,
          botName: bot.name.slice(0, 128),
          webhookSecretHash: secretHash(secret),
          connectedBy: input.userId,
        });
      });
    } catch (e) {
      if (isUnique(e, 'telegram_settings_bot_uq')) throw new TelegramChannelError('bot_in_use');
      throw e;
    }
    // A different bot's chats mean nothing to this one (§5.2).
    await tx.execute(sql`delete from telegram_chats where bot_id <> ${bot.id}`);
    await audit.append(tx, input.tenantId, {
      action: 'channel.connected',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'channel',
      subjectId: id,
      payload: { kind: auditCode('telegram'), botId: auditCode(String(bot.id)) },
    });
    return id;
  });
  await registerWebhook(zdb, deps, input.tenantId, connectionId, bot.token, secret);
}

/** `PUT /api/v1/channels/telegram/token` (D6): a new token for the same bot; recovers at once. */
export async function replaceTelegramToken(
  zdb: ZoneDb,
  deps: TelegramSettingsDeps,
  input: { tenantId: string; userId: string; token: string; settingsVersion: number },
): Promise<void> {
  const bot = await botOf(deps, input.token);
  const secret = newSecret();
  const connectionId = await withTenant(zdb, input.tenantId, async (tx) => {
    const [settings] = await tx
      .select()
      .from(ts)
      .where(eq(ts.tenantId, input.tenantId))
      .for('update');
    if (!settings) throw new TelegramChannelError('not_connected');
    if (settings.version !== input.settingsVersion) throw new TelegramChannelError('stale');
    if (settings.botId !== bot.id) throw new TelegramChannelError('different_bot');
    const sealed = await sealTelegram(deps.sealer, settings.connectionId, {
      token: bot.token,
      webhookSecret: secret,
    });
    await tx
      .update(cc)
      .set({
        credentialCiphertext: Buffer.from(sealed.ciphertext),
        credentialKeyRef: sealed.keyRef,
        updatedAt: new Date(),
      })
      .where(eq(cc.id, settings.connectionId));
    await tx
      .update(ts)
      .set({
        webhookSecretHash: secretHash(secret),
        botUsername: bot.username,
        botName: bot.name.slice(0, 128),
        version: settings.version + 1,
      })
      .where(eq(ts.tenantId, input.tenantId));
    await audit.append(tx, input.tenantId, {
      action: 'channel.token_replaced',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'channel',
      subjectId: settings.connectionId,
      payload: { kind: auditCode('telegram'), connectionId: auditId(settings.connectionId) },
    });
    return settings.connectionId;
  });
  // The webhook with the new secret, then the health recorded at once (no 30-second wait).
  await registerWebhook(zdb, deps, input.tenantId, connectionId, bot.token, secret);
}

/**
 * `DELETE /api/v1/channels/telegram`: offline, credential and settings cleared, members'
 * alert links deleted; conversations and customer chats stay (§5.2). Then `deleteWebhook`,
 * best effort.
 */
export async function disconnectTelegram(
  zdb: ZoneDb,
  deps: TelegramSettingsDeps,
  input: { tenantId: string; userId: string; settingsVersion: number },
): Promise<void> {
  const token = await withTenant(zdb, input.tenantId, async (tx) => {
    const [settings] = await tx
      .select()
      .from(ts)
      .where(eq(ts.tenantId, input.tenantId))
      .for('update');
    if (!settings) throw new TelegramChannelError('not_connected');
    if (settings.version !== input.settingsVersion) throw new TelegramChannelError('stale');
    const creds = await telegramCredentialOf(tx, settings.connectionId);
    const token = await openTelegram(deps.sealer, creds).then(
      (c) => c.token,
      () => null,
    );
    const now = new Date();
    await tx
      .update(cc)
      .set({
        state: 'offline',
        stateChangedAt: now,
        stateChangedBy: input.userId,
        health: 'unknown',
        healthReason: null,
        healthFailures: 0,
        degradedSince: null,
        credentialCiphertext: null,
        credentialKeyRef: null,
        version: sql`${cc.version} + 1`,
        updatedAt: now,
      })
      .where(eq(cc.id, settings.connectionId));
    await tx.delete(ts).where(eq(ts.tenantId, input.tenantId));
    await tx.execute(sql`select telegram_alert_links_clear()`);
    await audit.append(tx, input.tenantId, {
      action: 'channel.disconnected',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'channel',
      subjectId: settings.connectionId,
      payload: { kind: auditCode('telegram'), connectionId: auditId(settings.connectionId) },
    });
    return token;
  });
  if (token)
    await clientOf(deps, token)
      .deleteWebhook()
      .catch(() => undefined);
}
