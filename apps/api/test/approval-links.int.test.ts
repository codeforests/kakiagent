/**
 * Signed approval links over HTTP (APR-03; UC-22 4, 5, 5b; FEAT-056 §3, §5.3; AC-2–AC-7):
 * the open route's states and errors, the sign-in link carrying the approval link, and
 * Google's `next=approve`.
 */
import { randomUUID } from 'node:crypto';
import { approvalLinkKey, signApprovalLink } from '@kaki/approvals';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { base32Decode, createGoogleSignIn, SESSION_COOKIE, totpAt, totpStep } from '@kaki/identity';
import { startTestOidcProvider, type TestOidcProvider } from '@kaki/identity/testing';
import { createConversation } from '@kaki/inbox';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { APP_URL, fakeMailer, sessionCookie, testApp, tokenIn } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
let ownerA: string;
const mailer = fakeMailer();
/** testConfig's MAGIC_LINK_SECRET: the route derives the same key. */
const key = approvalLinkKey('m'.repeat(32));
const DAY_MS = 24 * 60 * 60 * 1000;

const req = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};
const open = (token: string, cookie?: string) =>
  req('POST', '/api/v1/approval-links/open', cookie, { token });

async function member(email: string, tenantId = TENANT_A) {
  const u = await owner.query(`insert into users (email) values ($1) returning id`, [email]);
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [
    tenantId,
    u.rows[0].id,
  ]);
  return u.rows[0].id as string;
}
async function approval(tenantId = TENANT_A) {
  const conv = await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    createConversation(tx, tenantId, randomUUID()),
  );
  const { rows } = await owner.query<{ id: string }>(
    `insert into approvals (tenant_id, conversation_id, kind, request, draft, prices, sla_due_at, expires_at)
     values ($1, $2, 'quote', '{}', '{}', '[]', now() + interval '2 hours', now() + interval '7 days') returning id`,
    [tenantId, conv.id],
  );
  return rows[0]!.id;
}
const linkFor = async (userId: string, at = new Date(), tenantId = TENANT_A) =>
  signApprovalLink(key, { tenantId, approvalId: await approval(tenantId), userId }, at);

async function signIn(email: string, extra: Record<string, unknown> = {}) {
  const before = mailer.sent.length;
  const r = await req('POST', '/api/v1/auth/magic-link', undefined, { email, ...extra });
  expect(r.statusCode).toBe(202);
  const res = await req('POST', '/api/v1/auth/magic-link/verify', undefined, {
    token: tokenIn(mailer.sent[before]!),
  });
  expect(res.statusCode).toBe(200);
  return { body: res.json() as { next: string; approvalLink?: string }, cookie: cookieOf(res)! };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { mailer });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('POST /api/v1/approval-links/open (AC-2–AC-7)', () => {
  it('tampered is 400 link_invalid; expired is 410 link_expired without a cookie', async () => {
    const token = await linkFor(ownerA);
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect([(await open(tampered)).statusCode, (await open(tampered)).json().error]).toEqual([
      400,
      'link_invalid',
    ]);
    const stale = await linkFor(ownerA, new Date(Date.now() - DAY_MS - 60_000));
    const res = await open(stale);
    expect([res.statusCode, res.json().error]).toEqual([410, 'link_expired']);
    expect((await req('POST', '/api/v1/approval-links/open', undefined, {})).statusCode).toBe(400);
  });

  it('no cookie is sign_in (never 401); the signed-in recipient opens it once, then 409', async () => {
    const token = await linkFor(ownerA);
    const none = await open(token);
    expect([none.statusCode, none.json()]).toEqual([200, { state: 'sign_in' }]);
    const cookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const first = await open(token, cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: 'opened', switched: false });
    const again = await open(token, cookie);
    expect([again.statusCode, again.json().error]).toEqual([409, 'link_used']);
  });

  it('another member is 403 wrong_account; a recipient on another workspace is switched', async () => {
    const token = await linkFor(ownerA);
    await member('other@links.test');
    const other = await sessionCookie(tdb, 'other@links.test');
    const res = await open(token, other);
    expect([res.statusCode, res.json().error]).toEqual([403, 'wrong_account']);

    const both = await member('both@links.test', TENANT_B);
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`,
      [TENANT_A, both],
    );
    await owner.query(`update users set status = 'active' where id = $1`, [both]);
    const cookie = await sessionCookie(tdb, 'both@links.test');
    await owner.query(`update sessions set active_tenant_id = $1 where user_id = $2`, [
      TENANT_B,
      both,
    ]);
    const opened = await open(await linkFor(both), cookie);
    expect(opened.json()).toMatchObject({ state: 'opened', switched: true });
    expect((await req('GET', '/api/v1/me', cookie)).json()).toMatchObject({
      tenant: { id: TENANT_A },
    });
  });

  it('a session owing the code challenge is two_step and consumes nothing', async () => {
    const userId = await member('mfa@links.test');
    const { cookie } = await signIn('mfa@links.test');
    const start = await req('POST', '/api/v1/auth/mfa/enrolment', cookie);
    const { secret } = start.json();
    await owner.query(`update mfa_factors set last_used_step = null where user_id = $1`, [userId]);
    const code = totpAt(base32Decode(secret), totpStep(new Date()));
    expect(
      (await req('POST', '/api/v1/auth/mfa/enrolment/confirm', cookie, { code })).statusCode,
    ).toBe(200);
    const pending = await signIn('mfa@links.test');
    expect(pending.body.next).toBe('mfa');
    const token = await linkFor(userId);
    const res = await open(token, pending.cookie);
    expect([res.statusCode, res.json()]).toEqual([200, { state: 'two_step' }]);
    expect((await open(token, cookie)).json()).toMatchObject({ state: 'opened' });
  });
});

describe('sign-in continuation (D1; AC-4)', () => {
  it('a magic link requested with approvalLink hands it back on verify', async () => {
    const token = await linkFor(ownerA);
    const { body, cookie } = await signIn('owner@kaki-bakery.test', { approvalLink: token });
    expect(body).toEqual({ next: 'app', approvalLink: token });
    expect((await open(body.approvalLink!, cookie)).json()).toMatchObject({ state: 'opened' });
    // An ordinary sign-in carries none.
    expect((await signIn('owner@kaki-bakery.test')).body).toEqual({ next: 'app' });
  });

  it('a forged approval link, or one with an invitation, is 400', async () => {
    const forged = await req('POST', '/api/v1/auth/magic-link', undefined, {
      email: 'owner@kaki-bakery.test',
      approvalLink: 'abc.def',
    });
    expect([forged.statusCode, forged.json().error]).toEqual([400, 'link_invalid']);
    const both = await req('POST', '/api/v1/auth/magic-link', undefined, {
      email: 'owner@kaki-bakery.test',
      approvalLink: await linkFor(ownerA),
      invitation: 'x'.repeat(43),
    });
    expect(both.statusCode).toBe(400);
  });
});

describe('Google next=approve (AC-4)', () => {
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

  it('start with next=approve, then the callback returns to /approve', async () => {
    const start = await gapp.inject({
      method: 'GET',
      url: '/api/v1/auth/google/start?next=approve',
    });
    const url = start.headers.location as string;
    const cookies = start.cookies.filter(
      (c) => c.name === 'kaki_oauth' || c.name === 'kaki_oauth_next',
    );
    expect(cookies.find((c) => c.name === 'kaki_oauth_next')?.value).toBe('approve');
    const code = idp.issueCode(url, {
      sub: 'g-approve',
      email: 'owner@kaki-bakery.test',
      email_verified: true,
    });
    const state = new URL(url).searchParams.get('state')!;
    const res = await gapp.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=${code}&state=${state}`,
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    expect([res.statusCode, res.headers.location]).toEqual([302, '/approve']);
  });
});
