/**
 * Invitations, sign in to join and the last-used workspace on the real schema, as the
 * identity zone (FEAT-007 T2; AC-1–AC-3, AC-7).
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import type { Email, Mailer } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  authenticate,
  consumeMagicLink,
  createInvitation,
  InvitationError,
  listInvitations,
  lookupInvitation,
  requestMagicLink,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
  sendMagicLink,
  sendPendingInvitations,
  type MagicLinkConfig,
} from '../src/index.js';
import { withTenant } from '@kaki/db';

const cfg: MagicLinkConfig = { secret: 'm'.repeat(32), appUrl: 'http://localhost:5173' };

let tdb: TestDatabase;
let owner: pg.Client;
let ownerA: string;
let ownerB: string;
const id = () => tdb.zone('identity');
const actorA = () => ({ tenantId: TENANT_A, userId: ownerA });
const actorB = () => ({ tenantId: TENANT_B, userId: ownerB });

function fakeMailer() {
  const sent: Email[] = [];
  let down = false;
  const mailer: Mailer & { sent: Email[]; setDown(v: boolean): void } = {
    sent,
    setDown: (v) => (down = v),
    async send(e) {
      if (down) throw new Error('smtp down');
      sent.push(e);
    },
    async close() {},
  };
  return mailer;
}

const tokenIn = (e: Email) => /#token=([A-Za-z0-9_-]{43})/.exec(e.text)![1]!;

async function signIn(email: string) {
  const mailer = fakeMailer();
  const link = await requestMagicLink(id(), cfg, email);
  await sendMagicLink(id(), mailer, cfg, link.id);
  return consumeMagicLink(id(), tokenIn(mailer.sent[0]!));
}

async function sessionOf(email: string) {
  const s = await signIn(email);
  const r = await authenticate(id(), s.token);
  if (!r.ok) throw new Error('not signed in');
  return { token: s.token, auth: r.auth };
}

async function invite(email: string, role: 'admin' | 'agent' = 'agent', actor = actorA()) {
  const mailer = fakeMailer();
  const inv = await createInvitation(id(), cfg, actor, { email, role });
  await sendInvitation(id(), mailer, cfg, inv.id);
  return { inv, token: tokenIn(mailer.sent[0]!), email: mailer.sent[0]! };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const ids = await owner.query<{ email: string; id: string }>(
    `select email, id from users where email in ('owner@kaki-bakery.test', 'owner@second-tenant.test')`,
  );
  ownerA = ids.rows.find((r) => r.email === 'owner@kaki-bakery.test')!.id;
  ownerB = ids.rows.find((r) => r.email === 'owner@second-tenant.test')!.id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from magic_links`);
  await owner.query(`delete from invitations`);
  await owner.query(`delete from memberships where role <> 'owner'`);
  await owner.query(`delete from memberships where role = 'owner' and user_id not in ($1, $2)`, [
    ownerA,
    ownerB,
  ]);
});

describe('creating and sending (AC-1)', () => {
  it('emails one single-use link valid for 7 days, lists it pending and audits IDs only', async () => {
    const { inv, email, token } = await invite('  Staff1@Example.test ');
    expect(inv).toMatchObject({ email: 'staff1@example.test', role: 'agent', state: 'pending' });
    expect(inv.invitedBy).toBe('owner@kaki-bakery.test');
    const days = (Date.parse(inv.expiresAt) - Date.parse(inv.createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    expect(email.to).toBe('staff1@example.test');
    expect(email.text).toContain(`http://localhost:5173/invite#token=${token}`);
    expect(email.subject).toContain('Kaki Bakery');
    const listed = await withTenant(id(), TENANT_A, (tx) => listInvitations(tx));
    expect(listed).toEqual([expect.objectContaining({ id: inv.id, delivery: 'sent' })]);
    const audit = await owner.query(
      `select payload, subject_refs from audit_entries where tenant_id = $1 and event_type = 'member.invited'`,
      [TENANT_A],
    );
    expect(audit.rows).toEqual([
      { payload: { role: 'agent' }, subject_refs: [`invitation:${inv.id}`] },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('example.test');
  });

  it('refuses a member, a deactivated member and a live invite; replaces an expired one', async () => {
    await expect(
      createInvitation(id(), cfg, actorA(), { email: 'owner@kaki-bakery.test', role: 'agent' }),
    ).rejects.toEqual(new InvitationError('already_member'));
    const u = (await owner.query(`insert into users (email) values ('gone@x.test') returning id`))
      .rows[0].id;
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status) values ($1, $2, 'agent', 'deactivated')`,
      [TENANT_A, u],
    );
    await expect(
      createInvitation(id(), cfg, actorA(), { email: 'gone@x.test', role: 'agent' }),
    ).rejects.toEqual(new InvitationError('member_deactivated'));
    const { inv } = await invite('again@x.test');
    await expect(
      createInvitation(id(), cfg, actorA(), { email: 'again@x.test', role: 'admin' }),
    ).rejects.toEqual(new InvitationError('invite_pending'));
    // The same address in another tenant is a separate invitation.
    await createInvitation(id(), cfg, actorB(), { email: 'again@x.test', role: 'agent' });
    await owner.query(
      `update invitations set expires_at = now() - interval '1 minute' where id = $1`,
      [inv.id],
    );
    const fresh = await createInvitation(id(), cfg, actorA(), {
      email: 'again@x.test',
      role: 'admin',
    });
    expect(fresh.id).not.toBe(inv.id);
    const old = await owner.query(`select revoked_at from invitations where id = $1`, [inv.id]);
    expect(old.rows[0].revoked_at).not.toBeNull();
  });

  it('a failed send is queued; the sweep sends it once even with two workers', async () => {
    const down = fakeMailer();
    down.setDown(true);
    const inv = await createInvitation(id(), cfg, actorA(), { email: 'q@x.test', role: 'agent' });
    expect(await sendInvitation(id(), down, cfg, inv.id)).toBe(false);
    const listed = await withTenant(id(), TENANT_A, (tx) => listInvitations(tx));
    expect(listed[0]).toMatchObject({ delivery: 'queued' });
    await owner.query(`update invitations set next_attempt_at = now()`);
    const up = fakeMailer();
    const [a, b] = await Promise.all([
      sendPendingInvitations(id(), up, cfg),
      sendPendingInvitations(id(), up, cfg),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(up.sent).toHaveLength(1);
    expect(await sendPendingInvitations(id(), up, cfg)).toMatchObject({ sent: 0 });
  });

  it('the sweep purges invitations that ended more than 30 days ago (D9)', async () => {
    const { inv } = await invite('old@x.test');
    const { inv: keep } = await invite('keep@x.test');
    await owner.query(
      `update invitations set revoked_at = now() - interval '31 days' where id = $1`,
      [inv.id],
    );
    const r = await sendPendingInvitations(id(), fakeMailer(), cfg);
    expect(r.purged).toBe(1);
    const left = await owner.query(`select id from invitations`);
    expect(left.rows).toEqual([{ id: keep.id }]);
  });
});

describe('accepting (AC-2)', () => {
  it('the invited address joins once, with the invited role, and opens that tenant', async () => {
    const { token } = await invite('new1@x.test', 'admin');
    const me = await sessionOf('new1@x.test');
    expect(me.auth.tenantId).toBeNull();
    expect(await lookupInvitation(id(), token, { email: me.auth.email })).toMatchObject({
      state: 'valid',
      tenantName: 'Kaki Bakery',
      role: 'admin',
      email: 'new1@x.test',
      invitedBy: 'owner@kaki-bakery.test',
      signedInAs: 'new1@x.test',
    });
    await acceptInvitation(id(), token, me.auth);
    expect(await authenticate(id(), me.token)).toMatchObject({
      ok: true,
      auth: { tenantId: TENANT_A, role: 'admin' },
    });
    await expect(acceptInvitation(id(), token, me.auth)).rejects.toEqual(
      new InvitationError('link_used'),
    );
    expect(await lookupInvitation(id(), token, null)).toMatchObject({ state: 'used' });
    const audit = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'member.joined'`,
      [TENANT_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain('x.test');
  });

  it('another address is refused and the invitation stays usable', async () => {
    const { token } = await invite('right@x.test');
    const wrong = await sessionOf('owner@second-tenant.test');
    await expect(acceptInvitation(id(), token, wrong.auth)).rejects.toEqual(
      new InvitationError('invite_wrong_email'),
    );
    expect(await lookupInvitation(id(), token, null)).toMatchObject({ state: 'valid' });
    const right = await sessionOf('right@x.test');
    await acceptInvitation(id(), token, right.auth);
  });

  it('an existing member of another tenant joins and is switched there', async () => {
    const { token } = await invite('owner@second-tenant.test', 'agent');
    const b = await sessionOf('owner@second-tenant.test');
    expect(b.auth.tenantId).toBe(TENANT_B);
    await acceptInvitation(id(), token, b.auth);
    expect(await authenticate(id(), b.token)).toMatchObject({
      ok: true,
      auth: { tenantId: TENANT_A, role: 'agent' },
    });
  });

  it('expired, revoked and made-up links are refused; resend kills the old link', async () => {
    const me = await sessionOf('late@x.test');
    const { inv, token } = await invite('late@x.test');
    await owner.query(`update invitations set expires_at = now() - interval '1 second'`);
    await expect(acceptInvitation(id(), token, me.auth)).rejects.toEqual(
      new InvitationError('link_expired'),
    );
    expect(await lookupInvitation(id(), token, null)).toMatchObject({ state: 'expired' });

    const mailer = fakeMailer();
    const again = await resendInvitation(id(), cfg, actorA(), inv.id);
    expect(again.id).not.toBe(inv.id);
    expect(again.state).toBe('pending');
    await sendInvitation(id(), mailer, cfg, again.id);
    const newToken = tokenIn(mailer.sent[0]!);
    expect(await lookupInvitation(id(), token, null)).toMatchObject({ state: 'revoked' });
    await expect(acceptInvitation(id(), token, me.auth)).rejects.toEqual(
      new InvitationError('link_invalid'),
    );
    await revokeInvitation(id(), actorA(), again.id);
    await expect(acceptInvitation(id(), newToken, me.auth)).rejects.toEqual(
      new InvitationError('link_invalid'),
    );
    await expect(revokeInvitation(id(), actorA(), again.id)).rejects.toEqual(
      new InvitationError('not_found'),
    );
    await expect(lookupInvitation(id(), 'x'.repeat(43), null)).rejects.toEqual(
      new InvitationError('link_invalid'),
    );
  });

  it("tenant B can't resend or revoke tenant A's invitation", async () => {
    const { inv } = await invite('mine@x.test');
    await expect(resendInvitation(id(), cfg, actorB(), inv.id)).rejects.toEqual(
      new InvitationError('not_found'),
    );
    await expect(revokeInvitation(id(), actorB(), inv.id)).rejects.toEqual(
      new InvitationError('not_found'),
    );
  });
});

describe('sign in to join (AC-3, D4)', () => {
  it('a magic link carrying the invitation joins on verify and opens that tenant', async () => {
    const { token } = await invite('fresh@x.test', 'agent');
    await expect(requestMagicLink(id(), cfg, 'other@x.test', undefined, token)).rejects.toEqual(
      new InvitationError('invite_wrong_email'),
    );
    const mailer = fakeMailer();
    const link = await requestMagicLink(id(), cfg, 'Fresh@x.test', undefined, token);
    await sendMagicLink(id(), mailer, cfg, link.id);
    const s = await consumeMagicLink(id(), tokenIn(mailer.sent[0]!));
    expect(s.next).toBe('app');
    expect(await authenticate(id(), s.token)).toMatchObject({
      ok: true,
      auth: { tenantId: TENANT_A, role: 'agent' },
    });
    expect(await lookupInvitation(id(), token, null)).toMatchObject({ state: 'used' });
  });

  it('a link whose invitation was revoked meanwhile just signs in', async () => {
    const { inv, token } = await invite('slow@x.test');
    const mailer = fakeMailer();
    const link = await requestMagicLink(id(), cfg, 'slow@x.test', undefined, token);
    await sendMagicLink(id(), mailer, cfg, link.id);
    await revokeInvitation(id(), actorA(), inv.id);
    const s = await consumeMagicLink(id(), tokenIn(mailer.sent[0]!));
    expect(s.next).toBe('create-workspace');
  });
});

describe('last-used workspace (AC-7, D6)', () => {
  it('a new sign-in opens the workspace of the most recently used session', async () => {
    const { token } = await invite('owner@second-tenant.test', 'agent');
    const b = await sessionOf('owner@second-tenant.test');
    await acceptInvitation(id(), token, b.auth);
    await owner.query(
      `update sessions set last_seen_at = now() + interval '1 minute' where id = $1`,
      [b.auth.sessionId],
    );
    const next = await sessionOf('owner@second-tenant.test');
    expect(next.auth.tenantId).toBe(TENANT_A);
    // Once that membership is deactivated, sign-in falls back to an active one.
    await owner.query(
      `update memberships set status = 'deactivated' where tenant_id = $1 and user_id = $2`,
      [TENANT_A, ownerB],
    );
    const after = await sessionOf('owner@second-tenant.test');
    expect(after.auth.tenantId).toBe(TENANT_B);
  });
});
