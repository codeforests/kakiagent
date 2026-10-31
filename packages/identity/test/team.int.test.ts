/**
 * Team changes and the workspace switcher on the real schema, as the identity zone
 * (FEAT-007 T3; AC-4–AC-7).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import type { Email, Mailer } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  consumeMagicLink,
  listTeam,
  listWorkspaces,
  NotMemberError,
  requestMagicLink,
  sendMagicLink,
  switchWorkspace,
  TeamError,
  updateMember,
  type MagicLinkConfig,
} from '../src/index.js';

const cfg: MagicLinkConfig = { secret: 'm'.repeat(32), appUrl: 'http://localhost:5173' };

let tdb: TestDatabase;
let owner: pg.Client;
let ownerA: string;
let ownerB: string;
const id = () => tdb.zone('identity');
const asOwnerA = () => ({ tenantId: TENANT_A, userId: ownerA, role: 'owner' as const });

const mailer: Mailer & { sent: Email[] } = {
  sent: [],
  async send(e) {
    this.sent.push(e);
  },
  async close() {},
};

async function signIn(email: string) {
  mailer.sent.length = 0;
  const link = await requestMagicLink(id(), cfg, email);
  await sendMagicLink(id(), mailer, cfg, link.id);
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(mailer.sent[0]!.text)![1]!;
  return (await consumeMagicLink(id(), token)).token;
}

async function member(email: string, role: 'admin' | 'agent', tenantId = TENANT_A) {
  await owner.query(`insert into users (email) values ($1) on conflict do nothing`, [email]);
  const userId = (await owner.query(`select id from users where email = $1`, [email])).rows[0].id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
    tenantId,
    userId,
    role,
  ]);
  return userId as string;
}

const tenantOfSession = async (token: string) => {
  const r = await authenticate(id(), token);
  return r.ok ? r.auth.tenantId : r.reason;
};

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
  await owner.query(`delete from memberships where role <> 'owner'`);
});

describe('changing members (AC-4, AC-6)', () => {
  it("lists members owner first and refuses the Owner's row and your own", async () => {
    const admin = await member('t-admin@x.test', 'admin');
    await member('t-agent@x.test', 'agent');
    const team = await withTenant(id(), TENANT_A, (tx) => listTeam(tx, admin));
    expect(team.members.map((m) => [m.email, m.you])).toEqual([
      ['owner@kaki-bakery.test', false],
      ['t-admin@x.test', true],
      ['t-agent@x.test', false],
    ]);
    const asAdmin = { tenantId: TENANT_A, userId: admin, role: 'admin' as const };
    await expect(updateMember(id(), asAdmin, ownerA, { role: 'agent' })).rejects.toEqual(
      new TeamError('owner_protected'),
    );
    await expect(updateMember(id(), asAdmin, admin, { role: 'agent' })).rejects.toEqual(
      new TeamError('self_change'),
    );
  });

  it('an Admin changes another Admin; each change is audited with codes only', async () => {
    const a1 = await member('t-a1@x.test', 'admin');
    const a2 = await member('t-a2@x.test', 'admin');
    const r = await updateMember(id(), { tenantId: TENANT_A, userId: a1, role: 'admin' }, a2, {
      role: 'agent',
    });
    expect(r.team.members.find((m) => m.userId === a2)?.role).toBe('agent');
    const audit = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'member.role_changed'
       order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(audit.rows[0].payload).toEqual({ from: 'admin', to: 'agent' });
  });

  it('approval rights: only the Owner, only on an active Agent, cleared by a role change', async () => {
    const agent = await member('t-r1@x.test', 'agent');
    const admin = await member('t-r2@x.test', 'admin');
    const asAdmin = { tenantId: TENANT_A, userId: admin, role: 'admin' as const };
    await expect(updateMember(id(), asAdmin, agent, { approvalRights: true })).rejects.toEqual(
      new TeamError('forbidden'),
    );
    await expect(updateMember(id(), asOwnerA(), admin, { approvalRights: true })).rejects.toEqual(
      new TeamError('not_agent'),
    );
    const granted = await updateMember(id(), asOwnerA(), agent, { approvalRights: true });
    expect(granted.team.members.find((m) => m.userId === agent)?.approvalRights).toBe(true);
    const token = await signIn('t-r1@x.test');
    expect(await authenticate(id(), token)).toMatchObject({ auth: { approvalRights: true } });
    await updateMember(id(), asOwnerA(), agent, { role: 'admin' });
    await updateMember(id(), asOwnerA(), agent, { role: 'agent' });
    const back = await withTenant(id(), TENANT_A, (tx) => listTeam(tx, ownerA));
    expect(back.members.find((m) => m.userId === agent)?.approvalRights).toBe(false);
    await updateMember(id(), asOwnerA(), agent, { status: 'deactivated' });
    await expect(updateMember(id(), asOwnerA(), agent, { approvalRights: true })).rejects.toEqual(
      new TeamError('member_deactivated'),
    );
    await expect(updateMember(id(), asOwnerA(), agent, { role: 'admin' })).rejects.toEqual(
      new TeamError('member_deactivated'),
    );
  });

  it("tenant B's owner can't change tenant A's member", async () => {
    const agent = await member('t-x@x.test', 'agent');
    await expect(
      updateMember(id(), { tenantId: TENANT_B, userId: ownerB, role: 'owner' }, agent, {
        status: 'deactivated',
      }),
    ).rejects.toEqual(new TeamError('not_found'));
  });
});

describe('ending sessions (AC-5, D5)', () => {
  it('deactivation revokes the member’s sessions on that tenant only; reactivation keeps the role', async () => {
    const userId = await member('t-two@x.test', 'admin');
    await member('t-two@x.test', 'agent', TENANT_B);
    const onA = await signIn('t-two@x.test');
    const onB = await signIn('t-two@x.test');
    await switchWorkspace(id(), { sessionId: (await sessionId(onB))!, userId }, TENANT_B);
    await switchWorkspace(id(), { sessionId: (await sessionId(onA))!, userId }, TENANT_A);
    const r = await updateMember(id(), asOwnerA(), userId, { status: 'deactivated' });
    expect(r.revoked).toBe(1);
    expect(await tenantOfSession(onA)).toBe('revoked');
    expect(await tenantOfSession(onB)).toBe(TENANT_B);
    expect(await listWorkspaces(id(), userId, TENANT_B)).toEqual([
      { id: TENANT_B, name: expect.any(String), role: 'agent', current: true },
    ]);
    await expect(
      switchWorkspace(id(), { sessionId: (await sessionId(onB))!, userId }, TENANT_A),
    ).rejects.toBeInstanceOf(NotMemberError);
    await updateMember(id(), asOwnerA(), userId, { status: 'active' });
    const team = await withTenant(id(), TENANT_A, (tx) => listTeam(tx, ownerA));
    expect(team.members.find((m) => m.userId === userId)).toMatchObject({
      role: 'admin',
      status: 'active',
    });
  });

  it('a role change revokes the member’s session on that tenant', async () => {
    const userId = await member('t-role@x.test', 'agent');
    const token = await signIn('t-role@x.test');
    const r = await updateMember(id(), asOwnerA(), userId, { role: 'admin' });
    expect(r.revoked).toBe(1);
    expect(await authenticate(id(), token)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('workspaces (AC-7)', () => {
  it('lists exactly the active memberships by name, marks the current one, switches', async () => {
    const userId = await member('t-ws@x.test', 'agent');
    await member('t-ws@x.test', 'admin', TENANT_B);
    const token = await signIn('t-ws@x.test');
    const sid = (await sessionId(token))!;
    const list = await listWorkspaces(id(), userId, TENANT_A);
    expect(list.map((w) => [w.id, w.current])).toEqual(
      [...list].sort((a, b) => a.name.localeCompare(b.name)).map((w) => [w.id, w.id === TENANT_A]),
    );
    expect(list).toHaveLength(2);
    await switchWorkspace(id(), { sessionId: sid, userId }, TENANT_B);
    expect(await authenticate(id(), token)).toMatchObject({
      auth: { tenantId: TENANT_B, role: 'admin' },
    });
    await expect(
      switchWorkspace(id(), { sessionId: sid, userId: ownerA }, TENANT_A),
    ).rejects.toBeInstanceOf(NotMemberError);
    await expect(switchWorkspace(id(), { sessionId: sid, userId }, 'nope')).rejects.toBeInstanceOf(
      NotMemberError,
    );
  });
});

async function sessionId(token: string) {
  const r = await authenticate(id(), token);
  return r.ok ? r.auth.sessionId : null;
}
