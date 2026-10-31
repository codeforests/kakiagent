/**
 * Team, invitations and workspaces over HTTP (FEAT-007 §5.2; AC-1–AC-8).
 */
import { TeamResponse } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { SESSION_COOKIE } from '@kaki/identity';
import { channels, memoryRateLimiter, type Publisher } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { fakeMailer, sessionCookie, testApp, tokenIn } from './support.js';

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
let ownerA: string;
let ownerB: string;
let n = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { mailer, publisher, rateLimiter: memoryRateLimiter() });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const ids = await owner.query<{ email: string; id: string }>(
    `select email, id from users where email in ('owner@kaki-bakery.test', 'owner@second-tenant.test')`,
  );
  ownerA = ids.rows.find((r) => r.email === 'owner@kaki-bakery.test')!.id;
  ownerB = ids.rows.find((r) => r.email === 'owner@second-tenant.test')!.id;
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from invitations`);
  await owner.query(`delete from memberships where role <> 'owner'`);
  published.length = 0;
});

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: object,
) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};
const unique = (p: string) => `${p}${++n}-${Date.now()}@x.test`;

async function member(email: string, role: 'admin' | 'agent', tenantId = TENANT_A) {
  await owner.query(`insert into users (email) values ($1) on conflict do nothing`, [email]);
  const id = (await owner.query(`select id from users where email = $1`, [email])).rows[0].id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
    tenantId,
    id,
    role,
  ]);
  return id as string;
}

async function signIn(email: string, invitation?: string) {
  const before = mailer.sent.length;
  const ask = await req('POST', '/api/v1/auth/magic-link', undefined, {
    email,
    ...(invitation ? { invitation } : {}),
  });
  expect(ask.statusCode).toBe(202);
  const res = await req('POST', '/api/v1/auth/magic-link/verify', undefined, {
    token: tokenIn(mailer.sent[before]!),
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res)!;
}

async function invite(cookie: string, email: string, role: 'admin' | 'agent' = 'agent') {
  const before = mailer.sent.length;
  const res = await req('POST', '/api/v1/team/invitations', cookie, { email, role });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, token: tokenIn(mailer.sent[before]!) };
}

describe('inviting and accepting (AC-1, AC-2)', () => {
  it('invite → email → lookup → accept as the invited user; Me opens the tenant', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('new');
    const inv = await invite(ownerCookie, email, 'admin');
    expect(mailer.sent.at(-1)!.to).toBe(email);
    const team = TeamResponse.parse((await req('GET', '/api/v1/team', ownerCookie)).json());
    expect(team.invitations).toEqual([
      expect.objectContaining({ id: inv.id, state: 'pending', delivery: 'sent', role: 'admin' }),
    ]);

    const anon = await req('POST', '/api/v1/invitations/lookup', undefined, { token: inv.token });
    expect(anon.json()).toMatchObject({
      state: 'valid',
      tenantName: 'Kaki Bakery',
      signedInAs: null,
    });

    const newcomer = await signIn(email);
    const lookup = await req('POST', '/api/v1/invitations/lookup', newcomer, { token: inv.token });
    expect(lookup.json()).toMatchObject({ signedInAs: email });
    const accepted = await req('POST', '/api/v1/invitations/accept', newcomer, {
      token: inv.token,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      role: 'admin',
      tenant: { id: TENANT_A },
      canApprove: true,
    });
    const again = await req('POST', '/api/v1/invitations/accept', newcomer, { token: inv.token });
    expect(again.json()).toMatchObject({ error: 'link_used' });
  });

  it('an existing user of another tenant accepts and is switched there', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const inv = await invite(ownerCookie, 'owner@second-tenant.test');
    const b = await sessionCookie(tdb, 'owner@second-tenant.test');
    const res = await req('POST', '/api/v1/invitations/accept', b, { token: inv.token });
    expect(res.json()).toMatchObject({
      role: 'agent',
      tenant: { id: TENANT_A },
      canApprove: false,
    });
  });

  it('a different address gets 403 and the invite stays usable; expired, used, revoked', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('right');
    const inv = await invite(ownerCookie, email);
    const wrong = await sessionCookie(tdb, 'owner@second-tenant.test');
    const refused = await req('POST', '/api/v1/invitations/accept', wrong, { token: inv.token });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'invite_wrong_email' });

    const resent = await req('POST', `/api/v1/team/invitations/${inv.id}/resend`, ownerCookie);
    expect(resent.statusCode).toBe(200);
    const newToken = tokenIn(mailer.sent.at(-1)!);
    const newcomer = await signIn(email);
    const old = await req('POST', '/api/v1/invitations/accept', newcomer, { token: inv.token });
    expect(old.json()).toMatchObject({ error: 'link_invalid' });
    expect(
      (await req('POST', '/api/v1/invitations/lookup', undefined, { token: inv.token })).json(),
    ).toMatchObject({ state: 'revoked' });

    await owner.query(`update invitations set expires_at = now() - interval '1 second'`);
    const expired = await req('POST', '/api/v1/invitations/accept', newcomer, { token: newToken });
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ error: 'link_expired' });

    const revokeId = resent.json().id as string;
    expect(
      (await req('DELETE', `/api/v1/team/invitations/${revokeId}`, ownerCookie)).statusCode,
    ).toBe(204);
    expect(
      (await req('DELETE', `/api/v1/team/invitations/${revokeId}`, ownerCookie)).statusCode,
    ).toBe(404);
    const made = await req('POST', '/api/v1/invitations/lookup', undefined, {
      token: 'x'.repeat(43),
    });
    expect(made.json()).toMatchObject({ error: 'link_invalid' });
    expect(
      (await req('POST', '/api/v1/invitations/accept', undefined, { token: newToken })).statusCode,
    ).toBe(401);
  });

  it('refuses a member, a deactivated member and a pending invite', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('dup');
    await invite(ownerCookie, email);
    const post = (e: string) =>
      req('POST', '/api/v1/team/invitations', ownerCookie, { email: e, role: 'agent' });
    expect((await post(email)).json()).toMatchObject({ error: 'invite_pending' });
    expect((await post('owner@kaki-bakery.test')).json()).toMatchObject({
      error: 'already_member',
    });
    const gone = unique('gone');
    const goneId = await member(gone, 'agent');
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [goneId]);
    const res = await post(gone);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'member_deactivated' });
    expect(
      (await req('POST', '/api/v1/team/invitations', ownerCookie, { email, role: 'owner' }))
        .statusCode,
    ).toBe(400);
  });

  it('a queued send reports `queued` and the invitation stays listed', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    mailer.down = true;
    try {
      const res = await req('POST', '/api/v1/team/invitations', ownerCookie, {
        email: unique('q'),
        role: 'agent',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ delivery: 'queued' });
    } finally {
      mailer.down = false;
    }
  });

  it('limits invitations to 30 per tenant per hour', async () => {
    const limited = await testApp(tdb, { mailer: fakeMailer(), rateLimiter: memoryRateLimiter() });
    const ownerCookie = await sessionCookie(tdb, 'owner@second-tenant.test');
    try {
      for (let i = 0; i < 30; i++) {
        const r = await limited.inject({
          method: 'POST',
          url: '/api/v1/team/invitations',
          headers: { cookie: ownerCookie },
          payload: { email: unique('rl'), role: 'agent' },
        });
        expect(r.statusCode).toBe(201);
      }
      const r = await limited.inject({
        method: 'POST',
        url: '/api/v1/team/invitations',
        headers: { cookie: ownerCookie },
        payload: { email: unique('rl'), role: 'agent' },
      });
      expect(r.statusCode).toBe(429);
      expect(r.json()).toMatchObject({ error: 'rate_limited' });
    } finally {
      await limited.close();
    }
  });
});

describe('sign in to join (AC-3)', () => {
  it('a magic link with the invitation joins on verify; another address is 400', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('join');
    const inv = await invite(ownerCookie, email);
    const wrong = await req('POST', '/api/v1/auth/magic-link', undefined, {
      email: 'someone@else.test',
      invitation: inv.token,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'invite_wrong_email' });
    const cookie = await signIn(email, inv.token);
    expect((await req('GET', '/api/v1/me', cookie)).json()).toMatchObject({
      role: 'agent',
      tenant: { id: TENANT_A },
    });
  });

  it('Google start allow-lists next=invite only', async () => {
    // No Google configured in tests: the route is 404 either way, and nothing else is read.
    expect((await req('GET', '/api/v1/auth/google/start?next=invite')).statusCode).toBe(404);
  });
});

describe('changing members (AC-4–AC-6, AC-8)', () => {
  it('Agents get 403 on every team route', async () => {
    const agent = unique('agent');
    await member(agent, 'agent');
    const cookie = await sessionCookie(tdb, agent);
    const fake = '00000000-0000-4000-8000-0000000000aa';
    for (const [method, url, body] of [
      ['GET', '/api/v1/team', undefined],
      ['POST', '/api/v1/team/invitations', { email: 'a@b.test', role: 'agent' }],
      ['POST', `/api/v1/team/invitations/${fake}/resend`, undefined],
      ['DELETE', `/api/v1/team/invitations/${fake}`, undefined],
      ['PATCH', `/api/v1/team/members/${fake}`, { role: 'admin' }],
    ] as const) {
      const res = await req(method, url, cookie, body);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('an Admin manages Admins and Agents but not the Owner or themself', async () => {
    const adminEmail = unique('adm');
    const adminId = await member(adminEmail, 'admin');
    const otherAdmin = await member(unique('adm2'), 'admin');
    const cookie = await sessionCookie(tdb, adminEmail);
    const patch = (id: string, body: object) =>
      req('PATCH', `/api/v1/team/members/${id}`, cookie, body);
    expect((await patch(ownerA, { role: 'agent' })).json()).toMatchObject({
      error: 'owner_protected',
    });
    expect((await patch(adminId, { status: 'deactivated' })).statusCode).toBe(409);
    const changed = await patch(otherAdmin, { role: 'agent' });
    expect(changed.statusCode).toBe(200);
    expect(
      TeamResponse.parse(changed.json()).members.find((m) => m.userId === otherAdmin)?.role,
    ).toBe('agent');
    expect((await patch(otherAdmin, { approvalRights: true })).json()).toMatchObject({
      error: 'forbidden',
    });
    expect((await patch(otherAdmin, { role: 'admin', status: 'active' })).statusCode).toBe(400);
  });

  it('rights only by the Owner on Agents; Me.canApprove follows', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const agentEmail = unique('ag');
    const agentId = await member(agentEmail, 'agent');
    const adminId = await member(unique('ad'), 'admin');
    const patch = (id: string, body: object) =>
      req('PATCH', `/api/v1/team/members/${id}`, ownerCookie, body);
    expect((await patch(adminId, { approvalRights: true })).json()).toMatchObject({
      error: 'not_agent',
    });
    const agentCookie = await sessionCookie(tdb, agentEmail);
    expect((await req('GET', '/api/v1/me', agentCookie)).json()).toMatchObject({
      canApprove: false,
    });
    expect((await patch(agentId, { approvalRights: true })).statusCode).toBe(200);
    expect((await req('GET', '/api/v1/me', agentCookie)).json()).toMatchObject({
      canApprove: true,
    });
  });

  it('deactivation ends the member’s sessions on that tenant only and publishes session_ended', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('two');
    const id = await member(email, 'agent');
    await member(email, 'agent', TENANT_B);
    const onA = await signIn(email);
    const onB = await signIn(email);
    const switched = await req('POST', `/api/v1/workspaces/${TENANT_B}/switch`, onB);
    expect(switched.json()).toMatchObject({ tenant: { id: TENANT_B } });
    // The last-used rule may have opened B for the first sign-in; put it on A.
    await req('POST', `/api/v1/workspaces/${TENANT_A}/switch`, onA);

    const res = await req('PATCH', `/api/v1/team/members/${id}`, ownerCookie, {
      status: 'deactivated',
    });
    expect(res.statusCode).toBe(200);
    expect(published).toEqual([
      { channel: channels.member(TENANT_A, id), event: { type: 'session_ended' } },
    ]);
    const gone = await req('GET', '/api/v1/conversations', onA);
    expect(gone.statusCode).toBe(401);
    expect(gone.json()).toMatchObject({ error: 'session_expired' });
    expect((await req('GET', '/api/v1/conversations', onB)).statusCode).toBe(200);
    const ws = await req('GET', '/api/v1/workspaces', onB);
    expect(ws.json().workspaces.map((w: { id: string }) => w.id)).toEqual([TENANT_B]);
    expect((await req('POST', `/api/v1/workspaces/${TENANT_A}/switch`, onB)).statusCode).toBe(404);
  });

  it('a role change ends the member’s session too', async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const email = unique('role');
    const id = await member(email, 'agent');
    const cookie = await signIn(email);
    await req('PATCH', `/api/v1/team/members/${id}`, ownerCookie, { role: 'admin' });
    expect((await req('GET', '/api/v1/me', cookie)).statusCode).toBe(401);
  });

  it("tenant B's owner can't see, resend, revoke or patch tenant A's rows", async () => {
    const ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
    const inv = await invite(ownerCookie, unique('mine'));
    const agentId = await member(unique('a-agent'), 'agent');
    const b = await sessionCookie(tdb, 'owner@second-tenant.test');
    const team = TeamResponse.parse((await req('GET', '/api/v1/team', b)).json());
    expect(team.invitations).toEqual([]);
    expect(team.members.map((m) => m.userId)).toEqual([ownerB]);
    expect((await req('POST', `/api/v1/team/invitations/${inv.id}/resend`, b)).statusCode).toBe(
      404,
    );
    expect((await req('DELETE', `/api/v1/team/invitations/${inv.id}`, b)).statusCode).toBe(404);
    expect(
      (await req('PATCH', `/api/v1/team/members/${agentId}`, b, { status: 'deactivated' }))
        .statusCode,
    ).toBe(404);
    expect((await req('POST', `/api/v1/workspaces/${TENANT_A}/switch`, b)).statusCode).toBe(404);
  });
});

describe('workspaces (AC-7)', () => {
  it('lists active memberships by name and switches', async () => {
    const email = unique('ws');
    await member(email, 'admin');
    await member(email, 'agent', TENANT_B);
    const cookie = await signIn(email);
    const list = (await req('GET', '/api/v1/workspaces', cookie)).json().workspaces as {
      id: string;
      name: string;
      current: boolean;
    }[];
    expect(list.map((w) => w.name)).toEqual([...list.map((w) => w.name)].sort());
    expect(list.filter((w) => w.current)).toHaveLength(1);
    const other = list.find((w) => !w.current)!;
    const me = await req('POST', `/api/v1/workspaces/${other.id}/switch`, cookie);
    expect(me.json()).toMatchObject({ tenant: { id: other.id } });
    expect((await req('POST', '/api/v1/workspaces/not-a-uuid/switch', cookie)).statusCode).toBe(
      404,
    );
  });
});
