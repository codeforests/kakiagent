/**
 * The Telegram channel's settings in the dashboard zone (CHN-05, CHN-12; FEAT-037 §5.2,
 * §5.5) with a fake Bot API: connect, replace, disconnect, the health check and the
 * degraded alert. The routes over these are in `apps/api/test/telegram-channel.int.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { localSealer } from '@kaki/platform/secrets';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_REGISTRY,
  connectTelegram,
  disconnectTelegram,
  replaceTelegramToken,
  runChannelHealth,
  TelegramChannelError,
  telegramAdapter,
  telegramAlerts,
  telegramChannelView,
  withAdapter,
} from '../src/index.js';
import { fakeBotApi, fixtureToken } from '../src/telegram/fake.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userId: string;
const sealer = localSealer(randomBytes(32));
const fake = fakeBotApi();
const deps = {
  sealer,
  hookUrl: (id: string) => `https://hooks.kaki.test/hooks/telegram/${id}`,
  api: { base: fake.base, fetch: fake.fetch },
};
const registry = withAdapter(CHANNEL_REGISTRY, 'telegram', () => telegramAdapter(deps));
const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const view = (t = TENANT_A) => dash(t, (tx) => telegramChannelView(tx, t));
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof TelegramChannelError ? e.code : String(e)),
  );
const connect = (token: string, tenantId = TENANT_A) =>
  connectTelegram(tdb.zone('dashboard'), deps, { tenantId, userId, token });
const TOKEN = fixtureToken(810001);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userId = (
    await owner.query<{ user_id: string }>(
      `select user_id from memberships where tenant_id = $1 and role = 'owner' limit 1`,
      [TENANT_A],
    )
  ).rows[0]!.user_id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('Telegram settings (FEAT-037 §5.2)', () => {
  it('connects offline and hidden, stores only ciphertext and the secret hash, registers the webhook', async () => {
    expect(await view()).toMatchObject({ connected: false, bot: null, settingsVersion: 0 });
    await connect(TOKEN);
    const v = await view();
    expect(v).toMatchObject({
      connected: true,
      connection: { state: 'offline', health: 'ok', healthReason: null },
      bot: {
        id: '810001',
        username: 'kaki_810001_bot',
        name: 'Kaki Bot',
        link: 'https://t.me/kaki_810001_bot',
      },
      alertMembers: 0,
      settingsVersion: 1,
    });
    const { rows } = await owner.query(
      `select c.offline_mode, c.credential_key_ref, c.credential_ciphertext, s.webhook_secret_hash
       from channel_connections c join telegram_settings s on s.connection_id = c.id
       where c.tenant_id = $1 and c.kind = 'telegram'`,
      [TENANT_A],
    );
    expect(rows[0].offline_mode).toBe('hidden');
    expect(rows[0].credential_key_ref).toBeTruthy();
    expect(Buffer.from(rows[0].credential_ciphertext).toString('latin1')).not.toContain(TOKEN);
    expect(rows[0].webhook_secret_hash).toHaveLength(32);
    const hook = fake.webhooks.get(810001);
    expect(hook?.url).toBe(deps.hookUrl(v.connection!.id));
    const audits = await owner.query(
      `select payload::text from audit_entries where tenant_id = $1 and event_type = 'channel.connected' order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(audits.rows[0].payload).not.toContain(TOKEN.split(':')[1]);
    expect(await code(connect(TOKEN))).toBe('already_connected');
  });

  it('refuses a bad format, a token Telegram rejects and a bot another business has', async () => {
    expect(await code(connect('abc', TENANT_B))).toBe('invalid_format');
    expect(await code(connect('810009:revokedxxxxxxxxxxxxxxxxxxxxxxxxxxxx', TENANT_B))).toBe(
      'token_rejected',
    );
    expect(await code(connect(fixtureToken(810001, 'b'), TENANT_B))).toBe('bot_in_use');
    const b = await owner.query(
      `select count(*)::int as n from channel_connections where tenant_id = $1 and kind = 'telegram' and credential_ciphertext is not null`,
      [TENANT_B],
    );
    expect(b.rows[0].n).toBe(0);
  });

  it('replaces the token for the same bot only, and refuses a stale version', async () => {
    const before = await view();
    expect(
      await code(
        replaceTelegramToken(tdb.zone('dashboard'), deps, {
          tenantId: TENANT_A,
          userId,
          token: fixtureToken(810002),
          settingsVersion: before.settingsVersion,
        }),
      ),
    ).toBe('different_bot');
    expect(
      await code(
        replaceTelegramToken(tdb.zone('dashboard'), deps, {
          tenantId: TENANT_A,
          userId,
          token: fixtureToken(810001, 'c'),
          settingsVersion: before.settingsVersion + 5,
        }),
      ),
    ).toBe('stale');
    const oldSecret = fake.webhooks.get(810001)!.secret;
    await replaceTelegramToken(tdb.zone('dashboard'), deps, {
      tenantId: TENANT_A,
      userId,
      token: fixtureToken(810001, 'c'),
      settingsVersion: before.settingsVersion,
    });
    expect((await view()).settingsVersion).toBe(before.settingsVersion + 1);
    expect(fake.webhooks.get(810001)!.secret).not.toBe(oldSecret);
  });

  it('a revoked token degrades and alerts each Owner and Admin once; a replacement recovers and cancels', async () => {
    fake.revoke(fixtureToken(810001, 'c'));
    const outbox = tdb.zone('outbox');
    await runChannelHealth(outbox, { registry });
    const v = await view();
    expect(v.connection).toMatchObject({ health: 'degraded', healthReason: 'credential_revoked' });
    const alerts = async () =>
      (
        await owner.query<{ user_id: string; status: string; channel: string }>(
          `select n.user_id, n.status, n.channel from notifications n
           where n.tenant_id = $1 and n.kind = 'channel_degraded' order by user_id, channel`,
          [TENANT_A],
        )
      ).rows;
    const managers = (
      await owner.query<{ user_id: string }>(
        `select user_id from memberships where tenant_id = $1 and status = 'active' and role in ('owner', 'admin') order by user_id`,
        [TENANT_A],
      )
    ).rows.map((r) => r.user_id);
    const first = await alerts();
    expect([...new Set(first.map((a) => a.user_id))]).toEqual(managers);
    // FEAT-037 D8 (T7): the business has a bot, so each manager gets an email and a Telegram row.
    expect(first.map((a) => a.channel)).toEqual(managers.flatMap(() => ['email', 'telegram']));
    expect(first.every((a) => a.status === 'pending')).toBe(true);
    await runChannelHealth(outbox, { registry });
    expect(await alerts()).toHaveLength(first.length);
    await replaceTelegramToken(tdb.zone('dashboard'), deps, {
      tenantId: TENANT_A,
      userId,
      token: fixtureToken(810001, 'd'),
      settingsVersion: v.settingsVersion,
    });
    expect((await view()).connection?.health).toBe('ok');
    expect((await alerts()).every((a) => a.status === 'cancelled')).toBe(true);
  });

  it("a webhook someone else set is credential_invalid and isn't taken back", async () => {
    fake.setForeignWebhook(810001, 'https://elsewhere.test/hook');
    await owner.query(
      `update channel_connections set health_checked_at = now() - interval '1 hour' where tenant_id = $1 and kind = 'telegram'`,
      [TENANT_A],
    );
    await runChannelHealth(tdb.zone('outbox'), { registry });
    expect((await view()).connection).toMatchObject({
      health: 'degraded',
      healthReason: 'credential_invalid',
    });
    expect(fake.webhooks.get(810001)?.url).toBe('https://elsewhere.test/hook');
  });

  it('disconnects: offline, credential and settings gone, alert links deleted, webhook removed', async () => {
    const v = await view();
    await owner.query(
      `insert into telegram_alert_links (tenant_id, user_id, chat_id, linked_at) values ($1, $2, 99, now())`,
      [TENANT_A, userId],
    );
    expect((await view()).alertMembers).toBe(1);
    expect(
      await code(
        disconnectTelegram(tdb.zone('dashboard'), deps, {
          tenantId: TENANT_A,
          userId,
          settingsVersion: v.settingsVersion + 1,
        }),
      ),
    ).toBe('stale');
    fake.webhooks.set(810001, { url: deps.hookUrl(v.connection!.id), secret: 'x' });
    await disconnectTelegram(tdb.zone('dashboard'), deps, {
      tenantId: TENANT_A,
      userId,
      settingsVersion: v.settingsVersion,
    });
    expect(await view()).toMatchObject({ connected: false, bot: null });
    const { rows } = await owner.query(
      `select c.state, c.credential_ciphertext,
         (select count(*)::int from telegram_alert_links where tenant_id = $1) as links
       from channel_connections c where c.tenant_id = $1 and c.kind = 'telegram'`,
      [TENANT_A],
    );
    expect(rows[0]).toEqual({ state: 'offline', credential_ciphertext: null, links: 0 });
    expect(fake.webhooks.has(810001)).toBe(false);
    // Reconnecting reuses the connection row.
    await connect(fixtureToken(810001, 'd'));
    expect((await view()).connection?.id).toBe(v.connection!.id);
  });
});

describe('alerts on Telegram (FEAT-037 §5.5, D9; AC-6)', () => {
  // Built per call: the database starts in beforeAll.
  const alerts = () => telegramAlerts({ zdb: tdb.zone('visitor'), sealer, api: deps.api });
  const send = (text = 'Kaki: A customer asked to talk to a person.') =>
    alerts().send({ tenantId: TENANT_A, userId, text });
  const linkCount = async () =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int as n from telegram_alert_links where tenant_id = $1 and user_id = $2`,
        [TENANT_A, userId],
      )
    ).rows[0]!.n;

  it('no linked chat → no_channel, nothing sent', async () => {
    const before = fake.sent.length;
    expect(await send()).toBe('no_channel');
    expect(fake.sent.length).toBe(before);
  });

  it("a linked member gets the text in their chat, from the business's bot", async () => {
    await owner.query(
      `insert into telegram_alert_links (tenant_id, user_id, chat_id, telegram_name, linked_at)
       values ($1, $2, 555, 'Mei', now())`,
      [TENANT_A, userId],
    );
    expect(await send('hello owner')).toBe('sent');
    expect(fake.sent.at(-1)).toMatchObject({
      botId: 810001,
      method: 'sendMessage',
      chatId: 555,
      text: 'hello owner',
    });
  });

  it('another tenant sees no link of this one', async () => {
    expect(await alerts().send({ tenantId: TENANT_B, userId, text: 'x' })).toBe('no_channel');
  });

  it('the member blocked the bot → unlinked, no_channel from then on', async () => {
    fake.blocked.add(555);
    expect(await send()).toBe('no_channel');
    expect(await linkCount()).toBe(0);
    fake.blocked.delete(555);
  });

  it('a revoked token → auth (retried) and the channel is degraded', async () => {
    await owner.query(
      `insert into telegram_alert_links (tenant_id, user_id, chat_id, linked_at)
       values ($1, $2, 556, now())`,
      [TENANT_A, userId],
    );
    fake.revoke(fixtureToken(810001, 'd'));
    expect(await send()).toEqual({ failed: 'auth' });
    expect(await linkCount()).toBe(1);
    expect((await view()).connection?.health).toBe('degraded');
  });
});
