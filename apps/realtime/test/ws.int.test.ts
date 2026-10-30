import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { findOrCreateUser, revokeSession, SESSION_COOKIE, startSession } from '@kaki/identity';
import { channels, createLogger, type Subscriber } from '@kaki/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { schema } from '../src/config.js';

// FEAT-005 AC-10 and §3.6: the dashboard socket authenticates on the identity zone.
let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
const subscribed: string[] = [];
const subscriber: Subscriber = {
  async subscribe(channel) {
    subscribed.push(channel);
    return async () => {};
  },
  ping: async () => true,
  close: async () => {},
};

async function signIn(email: string) {
  return tdb.zone('identity').db.transaction(async (tx) => {
    const user = await findOrCreateUser(tx, email);
    const { token } = await startSession(tx, user.id, 'magic_link');
    const { rows } = await tx.execute<{ id: string }>(
      sql`select id from sessions where user_id = ${user.id} order by created_at desc limit 1`,
    );
    return { cookie: `${SESSION_COOKIE}=${token}`, sessionId: rows[0]!.id };
  });
}

/** Opens `/ws` and resolves with the first frame, or the close code if refused. */
async function connect(cookie?: string) {
  const ws = await app.injectWS('/ws', { headers: cookie ? { cookie } : {} });
  return new Promise<{ code?: number; frame?: string }>((resolve) => {
    ws.on('message', (data) => {
      resolve({ frame: String(data) });
      ws.terminate();
    });
    ws.on('close', (code) => resolve({ code }));
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  const config = schema.parse({
    VALKEY_URL: 'redis://unused:6379',
    DASHBOARD_DATABASE_URL: tdb.urlFor('app_dashboard'),
    VISITOR_DATABASE_URL: tdb.urlFor('app_agent_visitor'),
    IDENTITY_DATABASE_URL: tdb.urlFor('app_identity'),
    VISITOR_TOKEN_SECRET: 'v'.repeat(40),
  });
  app = await buildApp({
    config,
    logger: createLogger('realtime-test', 'silent'),
    dashboardDb: tdb.zone('dashboard'),
    visitorDb: tdb.zone('visitor'),
    identityDb: tdb.zone('identity'),
    subscriber,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await tdb?.stop();
});

describe('/ws', () => {
  it("subscribes a signed-in member to their tenant's inbox", async () => {
    const { cookie } = await signIn('owner@kaki-bakery.test');
    expect(await connect(cookie)).toEqual({ frame: JSON.stringify({ type: 'ready' }) });
    expect(subscribed).toContain(channels.inbox(TENANT_A));
  });

  it('closes with 4401 without a session cookie or with an unknown one', async () => {
    expect(await connect()).toEqual({ code: 4401 });
    expect(await connect(`${SESSION_COOKIE}=${'x'.repeat(43)}`)).toEqual({ code: 4401 });
  });

  it('closes with 4401 once the session is signed out', async () => {
    const { cookie, sessionId } = await signIn('owner@kaki-bakery.test');
    await revokeSession(tdb.zone('identity'), sessionId);
    expect(await connect(cookie)).toEqual({ code: 4401 });
  });

  it('closes with 4403 for a user with no workspace', async () => {
    const { cookie } = await signIn('new-user@example.test');
    expect(await connect(cookie)).toEqual({ code: 4403 });
  });

  // FEAT-006 §5.3, AC-2 and AC-4: a session that still owes two-step gets no socket.
  it('closes with 4401 until the code challenge is passed, and 4403 while enrolment is due', async () => {
    const id = tdb.zone('identity').db;
    const setRequired = (on: boolean) =>
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        tx.execute(sql`update tenants set mfa_required = ${on} where id = ${TENANT_A}`),
      );
    const { rows } = await id.execute<{ id: string }>(
      sql`insert into users (email) values ('two-step@example.test') returning id`,
    );
    const userId = rows[0]!.id;
    await withTenant(tdb.zone('identity'), TENANT_A, (tx) =>
      tx.execute(
        sql`insert into memberships (tenant_id, user_id, role) values (${TENANT_A}, ${userId}, 'agent')`,
      ),
    );
    await id.execute(
      sql`insert into mfa_factors (user_id, secret_ciphertext, key_ref, confirmed_at)
          values (${userId}, '\\x00', 'local:v1', now())`,
    );
    const pending = await signIn('two-step@example.test');
    expect(await connect(pending.cookie)).toEqual({ code: 4401 });
    await id.execute(sql`update sessions set mfa_at = now() where id = ${pending.sessionId}`);
    expect((await connect(pending.cookie)).frame).toBeDefined();

    await id.execute(sql`delete from mfa_factors where user_id = ${userId}`);
    await setRequired(true);
    try {
      expect(await connect(pending.cookie)).toEqual({ code: 4403 });
    } finally {
      await setRequired(false);
    }
  });
});
