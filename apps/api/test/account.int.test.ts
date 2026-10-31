/**
 * My account over HTTP (FEAT-008 §5.2; AC-1–AC-7).
 */
import { Account, DeviceSessionList, ReauthRequired } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { emailChangeToken, SESSION_COOKIE } from '@kaki/identity';
import { channels, memoryRateLimiter, type Publisher } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { fakeMailer, testApp, testConfig, tokenIn } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
const mailer = fakeMailer();
const published: { channel: string; event: unknown }[] = [];
const publisher: Publisher = {
  async publish(channel, event) {
    published.push({ channel, event });
  },
  async close() {},
};
let n = 0;
const unique = (p: string) => `${p}${++n}-${Date.now()}@x.test`;
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { mailer, publisher, rateLimiter: memoryRateLimiter() });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => {
  published.length = 0;
});

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};
const userIdOf = async (email: string) =>
  (await owner.query(`select id from users where email = $1`, [email])).rows[0]?.id as
    string | undefined;

async function signIn(email: string, userAgent?: string) {
  const before = mailer.sent.length;
  const ask = await req('POST', '/api/v1/auth/magic-link', undefined, { email });
  expect(ask.statusCode).toBe(202);
  const res = await req(
    'POST',
    '/api/v1/auth/magic-link/verify',
    undefined,
    { token: tokenIn(mailer.sent[before]!) },
    userAgent ? { 'user-agent': userAgent } : {},
  );
  expect(res.statusCode).toBe(200);
  return cookieOf(res)!;
}

/** A signed-in Agent of tenant A with a fresh re-authentication (sign-in counts as one). */
async function agent(email = unique('acct')) {
  const cookie = await signIn(email);
  const id = (await userIdOf(email))!;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    id,
  ]);
  return { cookie, id, email };
}

/** Requests a change; returns the captured confirmation and notice. */
async function change(cookie: string, oldEmail: string, newEmail: string) {
  const before = mailer.sent.length;
  const res = await req('POST', '/api/v1/me/email-change', cookie, { email: newEmail });
  expect(res.statusCode).toBe(202);
  const sent = mailer.sent.slice(before);
  return {
    res,
    toNew: sent.find((e) => e.to === newEmail)!,
    notice: sent.find((e) => e.to === oldEmail)!,
  };
}

describe('profile name (AC-1)', () => {
  it('sets, shows in Me and the team, refuses bad names, clears', async () => {
    const a = await agent();
    const set = await req('PATCH', '/api/v1/me/profile', a.cookie, { displayName: ' Mei Ling ' });
    expect(set.statusCode).toBe(200);
    expect(Account.parse(set.json()).displayName).toBe('Mei Ling');
    expect((await req('GET', '/api/v1/me', a.cookie)).json().user.displayName).toBe('Mei Ling');
    const ownerCookie = await signIn('owner@kaki-bakery.test');
    const team = (await req('GET', '/api/v1/team', ownerCookie)).json();
    expect(team.members.find((m: { userId: string }) => m.userId === a.id).displayName).toBe(
      'Mei Ling',
    );
    for (const bad of ['x'.repeat(61), '', 'a\nb'])
      expect(
        (await req('PATCH', '/api/v1/me/profile', a.cookie, { displayName: bad })).statusCode,
      ).toBe(400);
    const cleared = await req('PATCH', '/api/v1/me/profile', a.cookie, { displayName: null });
    expect(cleared.json().displayName).toBeNull();
    expect((await req('GET', '/api/v1/me/account', undefined)).statusCode).toBe(401);
  });

  it('works for a user with no workspace yet', async () => {
    const cookie = await signIn(unique('nows'));
    expect((await req('GET', '/api/v1/me/account', cookie)).statusCode).toBe(200);
    expect(
      (await req('PATCH', '/api/v1/me/profile', cookie, { displayName: 'Ah Huat' })).statusCode,
    ).toBe(200);
  });
});

describe('email change (AC-2–AC-4)', () => {
  it('needs a fresh re-authentication; the same address is 409', async () => {
    const a = await agent();
    expect(
      (await req('POST', '/api/v1/me/email-change', a.cookie, { email: a.email })).json(),
    ).toMatchObject({ error: 'same_email' });
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [a.id],
    );
    const refused = await req('POST', '/api/v1/me/email-change', a.cookie, {
      email: unique('new'),
    });
    expect(refused.statusCode).toBe(403);
    expect(ReauthRequired.parse(refused.json()).methods).toEqual(['email']);
  });

  it('request → both emails; old sign-in still works; confirm moves it; once only', async () => {
    const a = await agent();
    await owner.query(`update users set google_sub = 'g-api' where id = $1`, [a.id]);
    const newEmail = unique('new');
    const { res, toNew, notice } = await change(a.cookie, a.email, newEmail);
    expect(Account.parse(res.json())).toMatchObject({
      email: a.email,
      pendingEmail: { email: newEmail, delivery: 'sent' },
    });
    expect(toNew.text).toMatch(/\/verify-email#token=/);
    expect(notice.text).toMatch(/n\*\*\*@x\.test/);
    expect(notice.text).not.toContain(newEmail);
    // Before confirming: the new address is someone else, the old one is still this user.
    await signIn(newEmail);
    expect(await userIdOf(newEmail)).not.toBe(a.id);
    const oldStill = await signIn(a.email);
    expect((await req('GET', '/api/v1/me', oldStill)).json().user.id).toBe(a.id);
    // A sign-in link to the old address, unused, dies on confirm.
    const before = mailer.sent.length;
    await req('POST', '/api/v1/auth/magic-link', undefined, { email: a.email });
    const oldLink = tokenIn(mailer.sent[before]!);
    const confirmed = await req('POST', '/api/v1/email-change/confirm', undefined, {
      token: tokenIn(toNew),
    });
    expect(confirmed.statusCode).toBe(409); // the new address got its own user above
    expect(confirmed.json().error).toBe('email_taken');
    // Retry with a fresh request now that address is free again.
    await owner.query(
      `delete from sessions where user_id in (select id from users where email = $1)`,
      [newEmail],
    );
    await owner.query(`delete from users where email = $1`, [newEmail]);
    const again = await change(a.cookie, a.email, newEmail);
    const ok = await req('POST', '/api/v1/email-change/confirm', undefined, {
      token: tokenIn(again.toNew),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: newEmail });
    const me = (await req('GET', '/api/v1/me', a.cookie)).json();
    expect(me.user.email).toBe(newEmail);
    expect((await req('GET', '/api/v1/me/account', a.cookie)).json().googleLinked).toBe(false);
    const dead = await req('POST', '/api/v1/auth/magic-link/verify', undefined, {
      token: oldLink,
    });
    expect(dead.json().error).toBe('link_invalid');
    expect(
      (
        await req('POST', '/api/v1/email-change/confirm', undefined, {
          token: tokenIn(again.toNew),
        })
      ).json().error,
    ).toBe('link_used');
    // The first link was replaced by the second request.
    expect(
      (
        await req('POST', '/api/v1/email-change/confirm', undefined, { token: tokenIn(toNew) })
      ).json().error,
    ).toBe('link_invalid');
  });

  it('a replaced or cancelled link is invalid; an expired one says so', async () => {
    const a = await agent();
    const first = await change(a.cookie, a.email, unique('r'));
    const second = await change(a.cookie, a.email, unique('r'));
    const confirm = (token: string) =>
      req('POST', '/api/v1/email-change/confirm', undefined, { token });
    expect((await confirm(tokenIn(first.toNew))).json().error).toBe('link_invalid');
    expect((await req('DELETE', '/api/v1/me/email-change', a.cookie)).statusCode).toBe(204);
    expect((await req('DELETE', '/api/v1/me/email-change', a.cookie)).statusCode).toBe(204);
    expect((await req('GET', '/api/v1/me/account', a.cookie)).json().pendingEmail).toBeNull();
    expect((await confirm(tokenIn(second.toNew))).json().error).toBe('link_invalid');
    const third = await change(a.cookie, a.email, unique('r'));
    await owner.query(`update email_changes set expires_at = now() where user_id = $1`, [a.id]);
    const expired = await confirm(tokenIn(third.toNew));
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error).toBe('link_expired');
  });

  it('a taken address: 202 as usual, an in-use email without a link, never confirmable', async () => {
    const a = await agent();
    const { res, toNew } = await change(a.cookie, a.email, 'owner@second-tenant.test');
    expect(res.json().pendingEmail.email).toBe('owner@second-tenant.test');
    expect(toNew.text).not.toMatch(/token=/);
    const { rows } = await owner.query(
      `select id from email_changes where user_id = $1 and cancelled_at is null`,
      [a.id],
    );
    const token = emailChangeToken(testConfig(tdb).MAGIC_LINK_SECRET, rows[0].id);
    const r = await req('POST', '/api/v1/email-change/confirm', undefined, { token });
    expect(r.json().error).toBe('link_invalid');
  });

  it('is limited to 5 requests per user per hour', async () => {
    const a = await agent();
    for (let i = 0; i < 5; i++) await change(a.cookie, a.email, unique('lim'));
    const sixth = await req('POST', '/api/v1/me/email-change', a.cookie, { email: unique('lim') });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('rate_limited');
  });

  it('a send failure answers queued', async () => {
    const a = await agent();
    mailer.down = true;
    try {
      const res = await req('POST', '/api/v1/me/email-change', a.cookie, { email: unique('q') });
      expect(res.statusCode).toBe(202);
      expect(res.json().pendingEmail.delivery).toBe('queued');
    } finally {
      mailer.down = false;
    }
  });
});

describe('devices (AC-5, AC-6, AC-7)', () => {
  it('lists the devices, signs out another, never this one or a stranger’s', async () => {
    const email = unique('dev');
    const mine = await signIn(email, CHROME_WIN);
    const phone = await signIn(email, SAFARI_IPHONE);
    const stranger = await signIn(unique('stranger'));
    const list = DeviceSessionList.parse((await req('GET', '/api/v1/me/sessions', mine)).json());
    expect(list.sessions.map((s) => [s.device, s.current])).toEqual([
      ['Chrome on Windows', true],
      ['Safari on iPhone', false],
    ]);
    const [me, other] = list.sessions;
    const strangerId = DeviceSessionList.parse(
      (await req('GET', '/api/v1/me/sessions', stranger)).json(),
    ).sessions[0]!.id;
    expect((await req('DELETE', `/api/v1/me/sessions/${strangerId}`, mine)).statusCode).toBe(404);
    expect((await req('DELETE', '/api/v1/me/sessions/not-a-uuid', mine)).statusCode).toBe(404);
    const self = await req('DELETE', `/api/v1/me/sessions/${me!.id}`, mine);
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toBe('current_session');
    expect((await req('DELETE', `/api/v1/me/sessions/${other!.id}`, mine)).statusCode).toBe(204);
    expect(published).toEqual([
      { channel: channels.session(other!.id), event: { type: 'session_ended' } },
    ]);
    const gone = await req('GET', '/api/v1/me', phone);
    expect(gone.statusCode).toBe(401);
    expect(gone.json().error).toBe('session_expired');
    expect((await req('GET', '/api/v1/me', stranger)).statusCode).toBe(200);
  });

  it('sign out and sign out everywhere close each ended session’s sockets', async () => {
    const email = unique('out');
    const a = await signIn(email);
    const b = await signIn(email);
    const c = await signIn(email);
    const ids = DeviceSessionList.parse(
      (await req('GET', '/api/v1/me/sessions', a)).json(),
    ).sessions.map((s) => s.id);
    const [aId] = ids;
    expect((await req('POST', '/api/v1/auth/sign-out', a)).statusCode).toBe(204);
    expect(published).toEqual([
      { channel: channels.session(aId!), event: { type: 'session_ended' } },
    ]);
    published.length = 0;
    expect((await req('POST', '/api/v1/auth/sign-out-everywhere', b)).statusCode).toBe(204);
    expect(published.map((p) => p.channel).sort()).toEqual(
      ids
        .slice(1)
        .map((id) => channels.session(id))
        .sort(),
    );
    expect((await req('GET', '/api/v1/me', c)).statusCode).toBe(401);
  });

  it('account audit entries carry no email or name', async () => {
    const a = await agent();
    await req('PATCH', '/api/v1/me/profile', a.cookie, { displayName: 'Siti Nur' });
    await change(a.cookie, a.email, unique('aud'));
    await req('DELETE', '/api/v1/me/email-change', a.cookie);
    const { rows } = await owner.query(
      `select event_type, payload from audit_entries where tenant_id = $1 and actor_ref = $2 order by seq`,
      [TENANT_A, a.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      'account.name_changed',
      'account.email_change_requested',
      'account.email_change_cancelled',
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('x.test');
    expect(text).not.toContain('Siti');
  });
});
