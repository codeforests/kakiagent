/** Google sign-in against a local OpenID provider (FEAT-005 T4; AC-5). */
import { startTestDatabase, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticate,
  createGoogleSignIn,
  GoogleSignInError,
  signInWithGoogle,
  type GoogleSignIn,
} from '../src/index.js';
import { startTestOidcProvider, type TestOidcProvider } from '../src/testing.js';

const REDIRECT = 'http://localhost:5173/api/v1/auth/google/callback';
let tdb: TestDatabase;
let owner: pg.Client;
let idp: TestOidcProvider;
let google: GoogleSignIn;

beforeAll(async () => {
  [tdb, idp] = await Promise.all([startTestDatabase(), startTestOidcProvider()]);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  google = createGoogleSignIn({
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: REDIRECT,
    cookieSecret: 'c'.repeat(32),
  });
});
afterAll(async () => {
  await owner?.end();
  await idp?.close();
  await tdb?.stop();
});

/** Runs start → consent → callback; returns what `finish` makes of it. */
async function roundTrip(
  claims: Record<string, unknown>,
  tamper: { state?: string; cookie?: string | undefined; nonce?: string } = {},
) {
  const { url, cookie } = await google.start();
  const u = new URL(url);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('scope')).toBe('openid email');
  expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
  const code = idp.issueCode(url, claims, tamper.nonce ? { nonce: tamper.nonce } : undefined);
  const cb = new URL(REDIRECT);
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', tamper.state ?? u.searchParams.get('state')!);
  return google.finish(cb, 'cookie' in tamper ? tamper.cookie : cookie);
}

describe('Google sign-in (AC-5)', () => {
  it('a verified Google account signs in, and a new user is sent to create a workspace', async () => {
    const who = await roundTrip({ sub: 'g-new', email: 'New@Gmail.Example', email_verified: true });
    expect(who).toEqual({ sub: 'g-new', email: 'new@gmail.example' });
    const s = await signInWithGoogle(tdb.zone('identity'), who);
    expect(s.next).toBe('create-workspace');
    expect(await authenticate(tdb.zone('identity'), s.token)).toMatchObject({
      ok: true,
      auth: { email: 'new@gmail.example' },
    });
    const row = await owner.query(`select google_sub from users where email = 'new@gmail.example'`);
    expect(row.rows[0].google_sub).toBe('g-new');
    const method = await owner.query(`select auth_method from sessions where user_id = $1`, [
      s.userId,
    ]);
    expect(method.rows[0].auth_method).toBe('google');
  });

  it('an existing owner signing in with Google opens their workspace', async () => {
    const who = await roundTrip({
      sub: 'g-bakery',
      email: 'owner@kaki-bakery.test',
      email_verified: true,
    });
    expect((await signInWithGoogle(tdb.zone('identity'), who)).next).toBe('app');
  });

  it.each([
    ['a wrong state', { state: 'wrong' }],
    ['a missing cookie', { cookie: undefined }],
    ['a tampered cookie', { cookie: 'eyJ2IjoieCJ9.bad' }],
    ['a wrong nonce', { nonce: 'other-nonce' }],
  ])('refuses %s', async (_name, tamper) => {
    await expect(
      roundTrip({ sub: 'g-x', email: 'x@gmail.example', email_verified: true }, tamper),
    ).rejects.toBeInstanceOf(GoogleSignInError);
  });

  it('refuses an unverified email', async () => {
    await expect(
      roundTrip({ sub: 'g-u', email: 'u@gmail.example', email_verified: false }),
    ).rejects.toBeInstanceOf(GoogleSignInError);
    await expect(roundTrip({ sub: 'g-u', email: 'u@gmail.example' })).rejects.toBeInstanceOf(
      GoogleSignInError,
    );
  });

  it('refuses a different Google account for an email already bound to one', async () => {
    await expect(
      signInWithGoogle(tdb.zone('identity'), { sub: 'g-impostor', email: 'new@gmail.example' }),
    ).rejects.toBeInstanceOf(GoogleSignInError);
    await expect(
      signInWithGoogle(tdb.zone('identity'), { sub: 'g-new', email: 'someone.else@gmail.example' }),
    ).rejects.toBeInstanceOf(GoogleSignInError);
  });
});
