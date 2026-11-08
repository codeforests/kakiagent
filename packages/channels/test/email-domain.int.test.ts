/**
 * The custom sending domain through the channel health job (CHN-04, CHN-12; FEAT-036 §5.1,
 * D4; AC-6): the outbox zone checks the domain, a lost record degrades the connection once,
 * recovery clears it.
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_REGISTRY,
  checkEmailDomain,
  runChannelHealth,
  withEmailHealth,
  type DomainChecks,
  type SendingIdentities,
  type TxtResolver,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let connectionId: string;
let checks: DomainChecks = { exists: true, dkim: true, mailFrom: true, dmarc: true };

const identities: SendingIdentities = {
  create: async () => ({ dkimTokens: ['a', 'b', 'c'], mailFrom: 'mail.kakibakery.sg' }),
  status: async () => ({ exists: checks.exists, dkim: checks.dkim, mailFrom: checks.mailFrom }),
  remove: async () => {},
};
const resolver: TxtResolver = {
  resolveTxt: async () => (checks.dmarc ? [['v=DMARC1; p=none;']] : []),
};

const registry = () =>
  withEmailHealth(CHANNEL_REGISTRY, { zdb: tdb.zone('outbox'), identities, resolver });

const state = async () =>
  (
    await owner.query<{
      domain_state: string | null;
      domain_verified_at: Date | null;
      domain_failing_since: Date | null;
      health: string;
      health_reason: string | null;
    }>(
      `select s.domain_state, s.domain_verified_at, s.domain_failing_since, c.health, c.health_reason
         from email_settings s join channel_connections c on c.id = s.connection_id
        where s.tenant_id = $1`,
      [TENANT_A],
    )
  ).rows[0]!;
const audits = async (action: string) =>
  Number(
    (
      await owner.query<{ n: number }>(
        `select count(*)::int n from audit_entries where tenant_id = $1 and event_type = $2`,
        [TENANT_A, action],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  connectionId = (
    await owner.query<{ id: string }>(
      `insert into channel_connections (tenant_id, kind, state, offline_mode, health, ai_reply_cap)
       values ($1, 'email', 'live', 'hidden', 'ok', 10) returning id`,
      [TENANT_A],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into email_settings (tenant_id, connection_id, forwarding_local) values ($1, $2, 'kaki-bakery')`,
    [TENANT_A, connectionId],
  );
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('email domain health (FEAT-036 §5.1, D4; AC-6)', () => {
  it('forwarding only is ok and changes nothing', async () => {
    const r = await checkEmailDomain({ zdb: tdb.zone('outbox'), identities, resolver }, TENANT_A);
    expect(r).toEqual({ health: { ok: true }, state: null, checks: null });
  });

  it('pending stays pending (and healthy) until every record passes, then verifies', async () => {
    await owner.query(
      `update email_settings set domain_address = 'hello@kakibakery.sg', domain = 'kakibakery.sg',
         domain_state = 'pending' where tenant_id = $1`,
      [TENANT_A],
    );
    checks = { exists: true, dkim: true, mailFrom: true, dmarc: false };
    await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(await state()).toMatchObject({ domain_state: 'pending', health: 'ok' });

    checks = { ...checks, dmarc: true };
    await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    const s = await state();
    expect(s).toMatchObject({ domain_state: 'verified', health: 'ok', domain_failing_since: null });
    expect(s.domain_verified_at).toBeInstanceOf(Date);
  });

  it('a lost record degrades the connection once; recovery clears it', async () => {
    checks = { ...checks, mailFrom: false };
    const first = await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(first.degraded).toBe(1);
    const failing = await state();
    expect(failing).toMatchObject({
      domain_state: 'failing',
      health: 'degraded',
      health_reason: 'credential_invalid',
    });
    expect(failing.domain_failing_since).toBeInstanceOf(Date);

    const again = await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(again.degraded).toBe(0);
    expect((await state()).domain_failing_since).toEqual(failing.domain_failing_since);
    expect(await audits('channel.degraded')).toBe(1);

    checks = { ...checks, mailFrom: true };
    const back = await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(back.recovered).toBe(1);
    expect(await state()).toMatchObject({
      domain_state: 'verified',
      health: 'ok',
      domain_failing_since: null,
    });
    expect(await audits('channel.recovered')).toBe(1);
  });

  it('an identity deleted at the provider is credential_revoked', async () => {
    checks = { ...checks, exists: false };
    await runChannelHealth(tdb.zone('outbox'), { registry: registry() });
    expect(await state()).toMatchObject({
      domain_state: 'failing',
      health: 'degraded',
      health_reason: 'credential_revoked',
    });
    checks = { exists: true, dkim: true, mailFrom: true, dmarc: true };
  });

  it('the dashboard zone runs the same check ("Check" on SCR-APP-038)', async () => {
    const r = await checkEmailDomain(
      { zdb: tdb.zone('dashboard'), identities, resolver },
      TENANT_A,
    );
    expect(r.state).toBe('verified');
    expect(r.health).toEqual({ ok: true });
  });
});
