import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_REGISTRY,
  ChannelConflictError,
  ChannelNotFoundError,
  checkChannelNow,
  listChannels,
  NoHealthCheckError,
  OFFLINE_DEFAULTS,
  OfflineModeError,
  OfflineTextError,
  recordHealth,
  reportSendFailure,
  runChannelHealth,
  saveOfflineSettings,
  setChannelState,
  TooSoonError,
  visitorChannel,
  type ChannelRegistry,
} from '../src/index.js';
import { fakeAdapter, fakeTransport, type FakeTransport } from './fake-adapter.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = randomUUID();

const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const visitor = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('visitor'), tenantId, fn);

let transport: FakeTransport;
const registry = (): ChannelRegistry => [
  ...CHANNEL_REGISTRY,
  {
    kind: 'telegram',
    name: 'Telegram',
    adapter: async () => fakeAdapter(transport),
    checksHealth: true,
    offlineModes: ['message'],
  },
];

async function widget(tenantId = TENANT_A) {
  const { rows } = await owner.query(
    `select id, version from channel_connections where tenant_id = $1 and kind = 'widget'`,
    [tenantId],
  );
  return rows[0] as { id: string; version: number };
}

async function telegram(tenantId: string, keyRef = 'local:v1') {
  const { rows } = await owner.query(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health,
       credential_ciphertext, credential_key_ref)
     values ($1, 'telegram', 'live', 'message', 'ok', '\\x01', $2) returning id`,
    [tenantId, keyRef],
  );
  return rows[0].id as string;
}

async function lastAudit(tenantId = TENANT_A) {
  const { rows } = await owner.query(
    `select event_type, payload from audit_entries where tenant_id = $1 order by seq desc limit 1`,
    [tenantId],
  );
  return rows[0] as { event_type: string; payload: Record<string, unknown> } | undefined;
}

async function health(id: string) {
  const { rows } = await owner.query(
    `select health, health_reason, health_failures, degraded_since, health_checked_at
     from channel_connections where id = $1`,
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
afterEach(async () => {
  transport = fakeTransport();
  await owner.query(`delete from channel_connections where kind <> 'widget'`);
  await owner.query(
    `update channel_connections set state = 'live', offline_mode = 'hidden',
       offline_message_en = null, offline_message_zh = null, health = 'ok', health_reason = null,
       health_failures = 0, health_checked_at = null, degraded_since = null`,
  );
});
transport = fakeTransport();

describe('go live and go offline (ONB-10, AC-2)', () => {
  it('lists the widget with its defaults and nothing to connect', async () => {
    const res = await dash(TENANT_A, (tx) => listChannels(tx));
    expect(res.connectable).toEqual([]);
    expect(res.channels).toHaveLength(1);
    expect(res.channels[0]).toMatchObject({
      kind: 'widget',
      name: 'Website chat widget',
      state: 'live',
      checksHealth: false,
      offlineModes: ['hidden', 'message'],
      offline: { mode: 'hidden', message: { en: null, zh: null }, defaults: OFFLINE_DEFAULTS },
    });
    expect(JSON.stringify(res)).not.toContain('credential');
  });

  it('goes offline and live, bumping the version and auditing kind and ID only', async () => {
    const w = await widget();
    const off = await dash(TENANT_A, (tx) =>
      setChannelState(tx, {
        tenantId: TENANT_A,
        userId: USER,
        id: w.id,
        version: w.version,
        state: 'offline',
      }),
    );
    expect(off).toMatchObject({ state: 'offline', version: w.version + 1 });
    expect(off.stateChangedAt).not.toBeNull();
    expect(await lastAudit()).toEqual({
      event_type: 'channel.offline',
      payload: { kind: 'widget', connectionId: w.id },
    });
    const { rows } = await owner.query(
      `select state_changed_by from channel_connections where id = $1`,
      [w.id],
    );
    expect(rows[0].state_changed_by).toBe(USER);
    const live = await dash(TENANT_A, (tx) =>
      setChannelState(tx, {
        tenantId: TENANT_A,
        userId: USER,
        id: w.id,
        version: off.version,
        state: 'live',
      }),
    );
    expect(live.state).toBe('live');
    expect((await lastAudit())?.event_type).toBe('channel.live');
  });

  it('repeating the current state changes and audits nothing; a stale version conflicts', async () => {
    const w = await widget();
    const before = await lastAudit();
    const same = await dash(TENANT_A, (tx) =>
      setChannelState(tx, {
        tenantId: TENANT_A,
        userId: USER,
        id: w.id,
        version: w.version,
        state: 'live',
      }),
    );
    expect(same.version).toBe(w.version);
    expect(await lastAudit()).toEqual(before);
    await expect(
      dash(TENANT_A, (tx) =>
        setChannelState(tx, {
          tenantId: TENANT_A,
          userId: USER,
          id: w.id,
          version: w.version + 5,
          state: 'offline',
        }),
      ),
    ).rejects.toBeInstanceOf(ChannelConflictError);
  });

  it("another tenant's connection ID is not found", async () => {
    const w = await widget(TENANT_A);
    await expect(
      dash(TENANT_B, (tx) =>
        setChannelState(tx, {
          tenantId: TENANT_B,
          userId: USER,
          id: w.id,
          version: w.version,
          state: 'offline',
        }),
      ),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});

describe('offline settings (AC-5)', () => {
  it('trims, stores null for empty, and audits field names only', async () => {
    const w = await widget();
    const item = await dash(TENANT_A, (tx) =>
      saveOfflineSettings(tx, {
        tenantId: TENANT_A,
        userId: USER,
        id: w.id,
        version: w.version,
        mode: 'message',
        message: { en: '  Opening 1 Nov. Call us!  ', zh: '   ' },
      }),
    );
    expect(item.offline).toMatchObject({
      mode: 'message',
      message: { en: 'Opening 1 Nov. Call us!', zh: null },
    });
    const a = await lastAudit();
    expect(a).toEqual({
      event_type: 'channel.offline_settings',
      payload: { kind: 'widget', mode: 'message', changed: ['mode', 'message_en'] },
    });
    expect(JSON.stringify(a)).not.toContain('Opening');
  });

  it('rejects hidden where the registry lacks it, over 300 characters, and a stale version', async () => {
    const w = await widget();
    const tg = await telegram(TENANT_A);
    const base = { tenantId: TENANT_A, userId: USER, message: { en: null, zh: null } };
    await expect(
      dash(TENANT_A, (tx) =>
        saveOfflineSettings(tx, { ...base, id: tg, version: 1, mode: 'hidden' }, registry()),
      ),
    ).rejects.toBeInstanceOf(OfflineModeError);
    await expect(
      dash(TENANT_A, (tx) =>
        saveOfflineSettings(tx, {
          ...base,
          id: w.id,
          version: w.version,
          mode: 'message',
          message: { en: 'x'.repeat(301), zh: null },
        }),
      ),
    ).rejects.toBeInstanceOf(OfflineTextError);
    await expect(
      dash(TENANT_A, (tx) =>
        saveOfflineSettings(tx, { ...base, id: w.id, version: w.version + 1, mode: 'message' }),
      ),
    ).rejects.toBeInstanceOf(ChannelConflictError);
  });
});

describe('visitorChannel', () => {
  it('resolves defaults and contacts, and fails closed without a row', async () => {
    await owner.query(
      `update channel_connections set state = 'offline', offline_mode = 'message',
         offline_message_zh = '下月开张' where tenant_id = $1`,
      [TENANT_A],
    );
    const v = await visitor(TENANT_A, (tx) => visitorChannel(tx, 'widget'));
    expect(v).toEqual({
      live: false,
      mode: 'message',
      message: { en: OFFLINE_DEFAULTS.en, zh: '下月开张' },
      contact: { email: 'hello@kaki-bakery.test', phone: expect.anything() },
    });
    expect(await visitor(TENANT_B, (tx) => visitorChannel(tx, 'widget'))).toMatchObject({
      live: true,
    });
    expect(await visitor(TENANT_A, (tx) => visitorChannel(tx, 'email'))).toEqual({
      live: false,
      mode: 'hidden',
      message: OFFLINE_DEFAULTS,
      contact: { email: null, phone: null },
    });
  });
});

describe('health (CHN-12, AC-6)', () => {
  async function apply(id: string, status: Parameters<typeof recordHealth>[2]) {
    return withTenant(tdb.zone('outbox'), TENANT_A, async (tx) => {
      const { rows } = await owner.query(
        `select id, tenant_id as "tenantId", kind, health, health_failures as "healthFailures",
           degraded_since as "degradedSince" from channel_connections where id = $1`,
        [id],
      );
      return recordHealth(tx, rows[0], status);
    });
  }

  it('revoked degrades at once; ok recovers; each transition audited once', async () => {
    const id = await telegram(TENANT_A);
    expect(await apply(id, { ok: false, reason: 'credential_revoked' })).toBe('degraded');
    expect(await health(id)).toMatchObject({
      health: 'degraded',
      health_reason: 'credential_revoked',
      health_failures: 1,
    });
    expect(await lastAudit()).toEqual({
      event_type: 'channel.degraded',
      payload: { kind: 'telegram', connectionId: id, reason: 'credential_revoked' },
    });
    const since = (await health(id)).degraded_since;
    expect(await apply(id, { ok: false, reason: 'credential_invalid' })).toBeNull();
    expect((await health(id)).degraded_since).toEqual(since);
    expect((await lastAudit())?.event_type).toBe('channel.degraded');
    expect(await apply(id, { ok: true })).toBe('recovered');
    expect(await health(id)).toMatchObject({
      health: 'ok',
      health_reason: null,
      health_failures: 0,
      degraded_since: null,
    });
    expect(await lastAudit()).toEqual({
      event_type: 'channel.recovered',
      payload: { kind: 'telegram', connectionId: id },
    });
  });

  it('unreachable degrades only at the second consecutive failure', async () => {
    const id = await telegram(TENANT_A);
    expect(await apply(id, { ok: false, reason: 'unreachable' })).toBeNull();
    expect(await health(id)).toMatchObject({ health: 'ok', health_failures: 1 });
    expect((await health(id)).health_checked_at).not.toBeNull();
    expect(await apply(id, { ok: false, reason: 'unreachable' })).toBe('degraded');
    expect(await health(id)).toMatchObject({ health: 'degraded', health_reason: 'unreachable' });
  });

  it('an auth failure on send degrades at once; other failures change nothing', async () => {
    const id = await telegram(TENANT_A);
    const report = (failed: 'auth' | 'transient' | 'permanent') =>
      withTenant(tdb.zone('outbox'), TENANT_A, (tx) =>
        reportSendFailure(tx, id, { ok: false, failed }),
      );
    expect(await report('transient')).toBeNull();
    expect(await report('permanent')).toBeNull();
    expect((await health(id)).health).toBe('ok');
    expect(await report('auth')).toBe('degraded');
    expect(await health(id)).toMatchObject({ health: 'degraded', health_reason: 'send_rejected' });
  });

  it('runChannelHealth checks only health-checked kinds, across tenants', async () => {
    const a = await telegram(TENANT_A);
    const b = await telegram(TENANT_B, 'revoked');
    const res = await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(res).toEqual({ checked: 2, degraded: 1, recovered: 0, failed: 0 });
    expect(transport.healthCalls.sort()).toEqual([a, b].sort());
    expect((await health(a)).health).toBe('ok');
    expect(await health(b)).toMatchObject({
      health: 'degraded',
      health_reason: 'credential_revoked',
    });
    expect(await runChannelHealth(tdb.zone('outbox'))).toEqual({
      checked: 0,
      degraded: 0,
      recovered: 0,
      failed: 0,
    });
  });

  it('a throw and a timeout count as unreachable; a failing tenant does not stop the others', async () => {
    const a = await telegram(TENANT_A);
    const b = await telegram(TENANT_B);
    transport.health = (creds) =>
      creds.connectionId === a ? Promise.reject(new Error('boom')) : new Promise(() => {});
    await runChannelHealth(tdb.zone('outbox'), { registry: registry(), timeoutMs: 50 });
    expect(await health(a)).toMatchObject({ health: 'ok', health_failures: 1 });
    expect(await health(b)).toMatchObject({ health: 'ok', health_failures: 1 });
    let calls = 0;
    const res = await runChannelHealth(tdb.zone('outbox'), {
      registry: registry(),
      timeoutMs: 50,
      now: () => {
        calls += 1;
        if (calls === 1) throw new Error('first tenant fails');
        return new Date();
      },
    });
    expect(res).toMatchObject({ checked: 1, degraded: 1, failed: 1 });
  });

  it('checkChannelNow refuses the widget and a second check within 30 s', async () => {
    const w = await widget();
    await expect(dash(TENANT_A, (tx) => checkChannelNow(tx, { id: w.id }))).rejects.toBeInstanceOf(
      NoHealthCheckError,
    );
    const id = await telegram(TENANT_A, 'revoked');
    const item = await dash(TENANT_A, (tx) =>
      checkChannelNow(tx, {
        id,
        registry: registry(),
        credentialOf: async (cid) => ({
          connectionId: cid,
          tenantId: TENANT_A,
          ciphertext: null,
          keyRef: 'revoked',
        }),
      }),
    );
    expect(item).toMatchObject({ health: 'degraded', healthReason: 'credential_revoked' });
    await expect(
      dash(TENANT_A, (tx) => checkChannelNow(tx, { id, registry: registry() })),
    ).rejects.toBeInstanceOf(TooSoonError);
  });
});
