/**
 * Sign-in, sessions and workspaces over HTTP (FEAT-005 design §3; AC-1–AC-3, AC-5–AC-13).
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { createGoogleSignIn, CURRENT_TERMS, SESSION_COOKIE } from '@kaki/identity';
import { startTestOidcProvider, type TestOidcProvider } from '@kaki/identity/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { APP_URL, fakeMailer, sessionCookie, testApp, tokenIn } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
const mailer = fakeMailer();
const current = {
  tos: CURRENT_TERMS.tos.version,
  aup: CURRENT_TERMS.aup.version,
  dpa: CURRENT_TERMS.dpa.version,
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { mailer });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const post = (a: App, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  a.inject({ method: 'POST', url, payload: payload as object, headers });
const get = (a: App, url: string, cookie?: string) =>
  a.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};

/** Requests a link for `email` and verifies the one that arrives. */
async function signIn(email: string) {
  const before = mailer.sent.length;
  expect((await post(app, '/api/v1/auth/magic-link', { email })).statusCode).toBe(202);
  const token = tokenIn(mailer.sent[before]!);
  const res = await post(app, '/api/v1/auth/magic-link/verify', { token });
  expect(res.statusCode).toBe(200);
  return { res, cookie: cookieOf(res)!, token };
}

describe('options', () => {
  it('lists the current terms and hides Google when it is not configured', async () => {
    const res = await get(app, '/api/v1/auth/options');
    expect(res.json()).toEqual({
      google: false,
      terms: [
        { document: 'tos', title: 'Terms of Service', version: current.tos },
        { document: 'aup', title: 'Acceptable Use Policy', version: current.aup },
        { document: 'dpa', title: 'Data Processing Agreement', version: current.dpa },
      ],
    });
    expect((await get(app, '/api/v1/auth/google/start')).statusCode).toBe(404);
  });
});

describe('magic links (AUTH-01)', () => {
  it('answers the same for registered and unknown addresses, and emails both (AC-1)', async () => {
    const known = await post(app, '/api/v1/auth/magic-link', { email: 'owner@kaki-bakery.test' });
    const unknown = await post(app, '/api/v1/auth/magic-link', { email: 'Nobody@Example.SG' });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.body).toBe(unknown.body);
    expect(known.json()).toEqual({ delayed: false });
    expect(mailer.sent.slice(-2).map((e) => e.to)).toEqual([
      'owner@kaki-bakery.test',
      'nobody@example.sg',
    ]);
    expect(mailer.sent.at(-1)!.text).toContain(`${APP_URL}/auth/verify#token=`);
    expect((await post(app, '/api/v1/auth/magic-link', { email: 'not-an-email' })).statusCode).toBe(
      400,
    );
  });

  it('refuses the 6th link for one address in 15 minutes, registered or not (AC-3)', async () => {
    for (const email of ['owner@second-tenant.test', 'ghost@example.sg']) {
      for (let i = 0; i < 5; i++)
        expect((await post(app, '/api/v1/auth/magic-link', { email })).statusCode).toBe(202);
      const sixth = await post(app, '/api/v1/auth/magic-link', { email });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json()).toMatchObject({ error: 'rate_limited' });
    }
    expect(
      (await post(app, '/api/v1/auth/magic-link', { email: 'someone.else@example.sg' })).statusCode,
    ).toBe(202);
  });

  it('refuses the 21st link from one IP in 15 minutes (AC-3)', async () => {
    const fresh = await testApp(tdb);
    try {
      for (let i = 0; i < 20; i++)
        expect(
          (await post(fresh, '/api/v1/auth/magic-link', { email: `ip${i}@example.sg` })).statusCode,
        ).toBe(202);
      expect(
        (await post(fresh, '/api/v1/auth/magic-link', { email: 'ip20@example.sg' })).statusCode,
      ).toBe(429);
    } finally {
      await fresh.close();
    }
  });

  it('says the link may be delayed when email is down, and still records it (AC-4)', async () => {
    mailer.down = true;
    try {
      const res = await post(app, '/api/v1/auth/magic-link', { email: 'slow@example.sg' });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ delayed: true });
    } finally {
      mailer.down = false;
    }
    const { rows } = await owner.query(
      `select sent_at, send_attempts from magic_links where email = 'slow@example.sg'`,
    );
    expect(rows).toEqual([{ sent_at: null, send_attempts: 1 }]);
  });

  it('signs in once with a session cookie; used, expired and invalid links fail (AC-2, AC-9)', async () => {
    const { res, token } = await signIn('first.timer@example.sg');
    expect(res.json()).toEqual({ next: 'create-workspace' });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(set).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true, path: '/' });
    expect(set.maxAge).toBe(30 * 24 * 3600);

    const again = await post(app, '/api/v1/auth/magic-link/verify', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({
      error: 'link_used',
      message: 'This link has already been used.',
    });
    expect(cookieOf(again)).toBeUndefined();

    await post(app, '/api/v1/auth/magic-link', { email: 'late@example.sg' });
    const late = tokenIn(mailer.sent.at(-1)!);
    await owner.query(
      `update magic_links set expires_at = now() - interval '1 second' where email = 'late@example.sg'`,
    );
    const expired = await post(app, '/api/v1/auth/magic-link/verify', { token: late });
    expect(expired.json()).toMatchObject({ error: 'link_expired' });
    const invalid = await post(app, '/api/v1/auth/magic-link/verify', { token: 'x'.repeat(43) });
    expect(invalid.json()).toMatchObject({ error: 'link_invalid' });
  });
});

describe('sessions and workspaces', () => {
  it('without a session: 401 unauthorized; with a dead cookie: 401 session_expired, cleared (AC-9)', async () => {
    const none = await get(app, '/api/v1/me');
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ error: 'unauthorized' });
    const dead = await get(app, '/api/v1/me', `${SESSION_COOKIE}=${'z'.repeat(43)}`);
    expect(dead.statusCode).toBe(401);
    expect(dead.json()).toMatchObject({ error: 'session_expired' });
    expect(dead.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('a new user creates a workspace and becomes its Owner (AC-6, AC-7, AC-8)', async () => {
    const { cookie } = await signIn('founder@florist.sg');
    const me = await get(app, '/api/v1/me', cookie);
    expect(me.json()).toMatchObject({
      user: { email: 'founder@florist.sg' },
      role: null,
      tenant: null,
    });
    const conv = await get(app, '/api/v1/conversations', cookie);
    expect(conv.statusCode).toBe(403);
    expect(conv.json()).toMatchObject({ error: 'no_workspace' });

    const outdated = await post(
      app,
      '/api/v1/workspaces',
      { businessName: 'Florist', accepted: { ...current, aup: '2020-01-01' } },
      { cookie },
    );
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json()).toMatchObject({ error: 'terms_outdated' });
    expect(
      (await post(app, '/api/v1/workspaces', { businessName: ' ', accepted: current }, { cookie }))
        .statusCode,
    ).toBe(400);
    expect((await get(app, '/api/v1/me', cookie)).json()).toMatchObject({ tenant: null });

    const created = await post(
      app,
      '/api/v1/workspaces',
      { businessName: 'Florist & Co', accepted: current },
      { cookie, origin: APP_URL },
    );
    expect(created.statusCode).toBe(201);
    const tenant = created.json().tenant;
    expect(tenant).toMatchObject({ name: 'Florist & Co', status: 'active' });
    expect((await get(app, '/api/v1/me', cookie)).json()).toMatchObject({
      role: 'owner',
      tenant: { id: tenant.id, name: 'Florist & Co' },
    });
    expect((await get(app, '/api/v1/conversations', cookie)).statusCode).toBe(200);
    expect(
      (await post(app, '/api/v1/workspaces', { businessName: 'X', accepted: current })).statusCode,
    ).toBe(401);
  });

  it('an existing member lands in the app on their tenant (AC-8)', async () => {
    const { res, cookie } = await signIn('owner@kaki-bakery.test');
    expect(res.json()).toEqual({ next: 'app' });
    expect((await get(app, '/api/v1/me', cookie)).json()).toMatchObject({
      role: 'owner',
      tenant: { id: TENANT_A, name: 'Kaki Bakery' },
    });
  });

  it('sign out ends this session; sign out everywhere ends all of them (AC-10)', async () => {
    const a = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const b = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const c = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const other = await sessionCookie(tdb, 'owner@second-tenant.test');

    const out = await post(app, '/api/v1/auth/sign-out', {}, { cookie: a });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((x) => x.name === SESSION_COOKIE)?.value).toBe('');
    for (const url of ['/api/v1/me', '/api/v1/conversations', '/api/v1/kb/facts'])
      expect((await get(app, url, a)).statusCode, url).toBe(401);
    expect((await get(app, '/api/v1/me', b)).statusCode).toBe(200);

    expect(
      (await post(app, '/api/v1/auth/sign-out-everywhere', {}, { cookie: b })).statusCode,
    ).toBe(204);
    expect((await get(app, '/api/v1/me', b)).statusCode).toBe(401);
    expect((await get(app, '/api/v1/me', c)).statusCode).toBe(401);
    expect((await get(app, '/api/v1/me', other)).statusCode).toBe(200);
    // Signing out without a session is harmless.
    expect((await post(app, '/api/v1/auth/sign-out', {})).statusCode).toBe(204);
    expect((await post(app, '/api/v1/auth/sign-out-everywhere', {})).statusCode).toBe(401);
  });

  it('deactivation and role changes apply on the next request (AC-11)', async () => {
    const userId = (
      await owner.query(`insert into users (email) values ('temp@kaki-bakery.test') returning id`)
    ).rows[0].id;
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')`,
      [TENANT_A, userId],
    );
    const cookie = await sessionCookie(tdb, 'temp@kaki-bakery.test');
    expect((await get(app, '/api/v1/kb/facts', cookie)).statusCode).toBe(200);
    await owner.query(`update memberships set role = 'agent' where user_id = $1`, [userId]);
    expect((await get(app, '/api/v1/kb/facts', cookie)).statusCode).toBe(403);
    expect((await get(app, '/api/v1/conversations', cookie)).statusCode).toBe(200);
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [userId]);
    const after = await get(app, '/api/v1/conversations', cookie);
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ error: 'no_workspace' });
    await owner.query(`update users set status = 'disabled' where id = $1`, [userId]);
    expect((await get(app, '/api/v1/me', cookie)).statusCode).toBe(401);
  });

  it('refuses a state-changing request from a foreign origin (AC-12)', async () => {
    const cookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const before = Number((await owner.query(`select count(*) from tenants`)).rows[0].count);
    const res = await post(
      app,
      '/api/v1/workspaces',
      { businessName: 'Evil', accepted: current },
      { cookie, origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(Number((await owner.query(`select count(*) from tenants`)).rows[0].count)).toBe(before);
    const out = await post(
      app,
      '/api/v1/auth/sign-out',
      {},
      { cookie, origin: 'https://evil.example' },
    );
    expect(out.statusCode).toBe(403);
    expect((await get(app, '/api/v1/me', cookie)).statusCode).toBe(200);
  });

  it('the dev sign-in is gone (AC-13)', async () => {
    expect((await post(app, '/api/dev/sign-in', { tenant: 'kaki-bakery' })).statusCode).toBe(404);
  });
});

describe('Google (AC-5)', () => {
  let idp: TestOidcProvider;
  let gapp: App;
  beforeAll(async () => {
    idp = await startTestOidcProvider();
    gapp = await testApp(tdb, {
      google: createGoogleSignIn({
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        redirectUri: `${APP_URL}/api/v1/auth/google/callback`,
        cookieSecret: 's'.repeat(32),
      }),
    });
  });
  afterAll(async () => {
    await gapp?.close();
    await idp?.close();
  });

  async function callback(claims: Record<string, unknown>, tamperState = false) {
    const start = await get(gapp, '/api/v1/auth/google/start');
    expect(start.statusCode).toBe(302);
    const url = start.headers.location as string;
    expect(url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    const oauth = start.cookies.find((c) => c.name === 'kaki_oauth')!;
    expect(oauth).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1/auth/google' });
    const state = tamperState ? 'wrong' : new URL(url).searchParams.get('state')!;
    const code = idp.issueCode(url, claims);
    return get(
      gapp,
      `/api/v1/auth/google/callback?code=${code}&state=${state}`,
      `kaki_oauth=${oauth.value}`,
    );
  }

  it('offers Google and signs a new user in, sending them to create a workspace', async () => {
    expect((await get(gapp, '/api/v1/auth/options')).json()).toMatchObject({ google: true });
    const res = await callback({ sub: 'g-1', email: 'g.user@gmail.example', email_verified: true });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/welcome');
    const cookie = cookieOf(res)!;
    expect((await get(gapp, '/api/v1/me', cookie)).json()).toMatchObject({
      user: { email: 'g.user@gmail.example' },
    });
  });

  it('sends an existing member to the app', async () => {
    const res = await callback({
      sub: 'g-2',
      email: 'owner@kaki-bakery.test',
      email_verified: true,
    });
    expect(res.headers.location).toBe('/');
  });

  it('a failed check creates no session and returns to sign-in with an error', async () => {
    for (const res of [
      await callback({ sub: 'g-3', email: 'x@gmail.example', email_verified: true }, true),
      await callback({ sub: 'g-3', email: 'x@gmail.example', email_verified: false }),
      await get(gapp, '/api/v1/auth/google/callback?code=abc&state=def'),
    ]) {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/sign-in?error=google');
      expect(cookieOf(res)).toBeUndefined();
    }
  });
});
