/**
 * Two-step verification and re-auth over HTTP (FEAT-006 §3; AC-1–AC-3, AC-5).
 */
import { ReauthRequired } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { base32Decode, SESSION_COOKIE, totpAt, totpStep } from '@kaki/identity';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { fakeMailer, testApp, tokenIn } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
const mailer = fakeMailer();

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

const req = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};

async function member(email: string) {
  const u = await owner.query(`insert into users (email) values ($1) returning id`, [email]);
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0].id,
  ]);
  return u.rows[0].id as string;
}

async function signIn(email: string) {
  const before = mailer.sent.length;
  expect((await req('POST', '/api/v1/auth/magic-link', undefined, { email })).statusCode).toBe(202);
  const res = await req('POST', '/api/v1/auth/magic-link/verify', undefined, {
    token: tokenIn(mailer.sent[before]!),
  });
  expect(res.statusCode).toBe(200);
  return { next: res.json().next as string, cookie: cookieOf(res)! };
}

const staleReauth = (userId: string) =>
  owner.query(`update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`, [
    userId,
  ]);
/** The current code; the replay guard is reset first, as if a step had passed. */
async function code(userId: string, secret: string) {
  await owner.query(`update mfa_factors set last_used_step = null where user_id = $1`, [userId]);
  return totpAt(base32Decode(secret), totpStep(new Date()));
}

/** Signs in and enrols over HTTP; returns the cookie, secret and codes. */
async function enrolled(email: string) {
  const userId = await member(email);
  const { cookie } = await signIn(email);
  const start = await req('POST', '/api/v1/auth/mfa/enrolment', cookie);
  expect(start.statusCode).toBe(201);
  const { secret } = start.json();
  const done = await req('POST', '/api/v1/auth/mfa/enrolment/confirm', cookie, {
    code: await code(userId, secret),
  });
  expect(done.statusCode).toBe(200);
  return { userId, cookie, secret: secret as string, codes: done.json().codes as string[] };
}

describe('enrolment, sign-in challenge and re-auth (AC-1, AC-2, AC-5)', () => {
  it('runs the whole flow', async () => {
    const userId = await member('flow@mfa.test');
    const { cookie, next } = await signIn('flow@mfa.test');
    expect(next).toBe('app');
    expect((await req('GET', '/api/v1/auth/mfa', cookie)).json()).toMatchObject({
      state: 'ok',
      enrolled: false,
      recoveryCodesLeft: 0,
      email: 'flow@mfa.test',
    });

    // Starting enrolment needs a fresh re-auth; unenrolled users get the email method.
    await staleReauth(userId);
    const refused = await req('POST', '/api/v1/auth/mfa/enrolment', cookie);
    expect(refused.statusCode).toBe(403);
    expect(ReauthRequired.parse(refused.json()).methods).toEqual(['email']);
    expect((await req('GET', '/api/v1/auth/reauth', cookie)).json()).toEqual({
      fresh: false,
      until: null,
      methods: ['email'],
    });

    const before = mailer.sent.length;
    const sent = await req('POST', '/api/v1/auth/reauth/email', cookie);
    expect(sent.statusCode).toBe(202);
    const email = mailer.sent[before]!;
    expect(email.subject).toBe('Confirm it’s you');
    const token = tokenIn(email);
    const elsewhere = await req('POST', '/api/v1/auth/magic-link/verify', undefined, { token });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json().error).toBe('link_other_session');
    const here = await req('POST', '/api/v1/auth/magic-link/verify', cookie, { token });
    expect(here.json()).toEqual({ next: 'reauthed' });
    expect(cookieOf(here)).toBeUndefined();
    expect((await req('GET', '/api/v1/auth/reauth', cookie)).json().fresh).toBe(true);

    const start = await req('POST', '/api/v1/auth/mfa/enrolment', cookie);
    expect(start.statusCode).toBe(201);
    const { secret, otpauthUri } = start.json();
    expect(otpauthUri).toContain('issuer=KakiAgent');
    const wrong = await req('POST', '/api/v1/auth/mfa/enrolment/confirm', cookie, {
      code: 'abcdef',
    });
    expect(wrong.json().error).toBe('code_invalid');
    const done = await req('POST', '/api/v1/auth/mfa/enrolment/confirm', cookie, {
      code: await code(userId, secret),
    });
    expect(done.json().codes).toHaveLength(10);
    expect((await req('POST', '/api/v1/auth/mfa/enrolment', cookie)).json().error).toBe(
      'mfa_already_enrolled',
    );

    // Sign out, sign in: the new session can only reach the challenge and sign-out.
    expect((await req('POST', '/api/v1/auth/sign-out', cookie)).statusCode).toBe(204);
    const s2 = await signIn('flow@mfa.test');
    expect(s2.next).toBe('mfa');
    for (const url of ['/api/v1/conversations', '/api/v1/me', '/api/v1/auth/reauth']) {
      const res = await req('GET', url, s2.cookie);
      expect([url, res.statusCode, res.json().error]).toEqual([url, 401, 'mfa_required']);
    }
    expect((await req('GET', '/api/v1/auth/mfa', s2.cookie)).json().state).toBe('challenge');
    const totp = await code(userId, secret);
    const passed = await req('POST', '/api/v1/auth/mfa/challenge', s2.cookie, {
      method: 'totp',
      code: totp,
    });
    expect(passed.statusCode).toBe(204);
    expect((await req('GET', '/api/v1/conversations', s2.cookie)).statusCode).toBe(200);
    expect((await req('GET', '/api/v1/me', s2.cookie)).statusCode).toBe(200);

    // The same code again is a replay; sign-out works while pending.
    const s3 = await signIn('flow@mfa.test');
    const replay = await req('POST', '/api/v1/auth/mfa/challenge', s3.cookie, {
      method: 'totp',
      code: totp,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'code_invalid', attemptsLeft: 4 });
    expect((await req('POST', '/api/v1/auth/sign-out', s3.cookie)).statusCode).toBe(204);

    // Enrolled users re-authenticate with the app, not email.
    await staleReauth(userId);
    const stale = await req('POST', '/api/v1/auth/mfa/recovery-codes', s2.cookie);
    expect(stale.statusCode).toBe(403);
    expect(ReauthRequired.parse(stale.json()).methods).toEqual(['totp', 'recovery']);
    expect((await req('POST', '/api/v1/auth/reauth/email', s2.cookie)).json().error).toBe(
      'use_authenticator',
    );
    const re = await req('POST', '/api/v1/auth/reauth', s2.cookie, {
      method: 'totp',
      code: await code(userId, secret),
    });
    expect(re.statusCode).toBe(204);
    expect((await req('POST', '/api/v1/auth/mfa/recovery-codes', s2.cookie)).statusCode).toBe(200);
    expect((await req('DELETE', '/api/v1/auth/mfa', s2.cookie)).statusCode).toBe(204);
    expect((await req('GET', '/api/v1/auth/mfa', s2.cookie)).json().enrolled).toBe(false);
  });
});

describe('lockout and recovery limits (AC-3)', () => {
  it('locks after five wrong codes with until, and a recovery code still gets in', async () => {
    const { userId, secret, codes } = await enrolled('lock@mfa.test');
    const { cookie } = await signIn('lock@mfa.test');
    const wrong = String((Number(await code(userId, secret)) + 1) % 1e6).padStart(6, '0');
    let last;
    for (let i = 0; i < 5; i++)
      last = await req('POST', '/api/v1/auth/mfa/challenge', cookie, {
        method: 'totp',
        code: wrong,
      });
    expect(last!.statusCode).toBe(429);
    expect(last!.json().error).toBe('mfa_locked');
    expect(new Date(last!.json().until).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const right = await req('POST', '/api/v1/auth/mfa/challenge', cookie, {
      method: 'totp',
      code: await code(userId, secret),
    });
    expect(right.statusCode).toBe(429);
    const rc = await req('POST', '/api/v1/auth/mfa/challenge', cookie, {
      method: 'recovery',
      code: codes[0],
    });
    expect(rc.statusCode).toBe(204);
    expect((await req('GET', '/api/v1/conversations', cookie)).statusCode).toBe(200);
  });

  it('refuses recovery codes with 429 after ten misses', async () => {
    await enrolled('rc@mfa.test');
    const { cookie } = await signIn('rc@mfa.test');
    for (let i = 0; i < 10; i++) {
      const miss = await req('POST', '/api/v1/auth/mfa/challenge', cookie, {
        method: 'recovery',
        code: 'aaaaa-aaaaa',
      });
      expect(miss.json()).toEqual({
        error: 'code_invalid',
        message: "That code didn't work. Check it and try again.",
      });
    }
    const limited = await req('POST', '/api/v1/auth/mfa/challenge', cookie, {
      method: 'recovery',
      code: 'aaaaa-aaaaa',
    });
    expect([limited.statusCode, limited.json().error]).toEqual([429, 'too_many_attempts']);
  });
});
