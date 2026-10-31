/**
 * The identity domain on the real schema, as the identity zone (FEAT-005 T3; AC-1, AC-2,
 * AC-4, AC-6, AC-7, AC-9–AC-11).
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { verifyChain } from '@kaki/governance';
import type { Email, Mailer } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  consumeMagicLink,
  createWorkspace,
  CURRENT_TERMS,
  hashToken,
  LinkError,
  magicLinkToken,
  requestMagicLink,
  revokeAllSessions,
  revokeSession,
  sendMagicLink,
  sendPendingMagicLinks,
  TermsOutdatedError,
  type MagicLinkConfig,
} from '../src/index.js';

const cfg: MagicLinkConfig = { secret: 'm'.repeat(32), appUrl: 'http://localhost:5173' };
const current = {
  tos: CURRENT_TERMS.tos.version,
  aup: CURRENT_TERMS.aup.version,
  dpa: CURRENT_TERMS.dpa.version,
};

let tdb: TestDatabase;
let owner: pg.Client;
const id = () => tdb.zone('identity');

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

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from magic_links`);
});

describe('magic links (AUTH-01)', () => {
  it('stores only the token hash and emails a working link (AC-1)', async () => {
    const mailer = fakeMailer();
    const link = await requestMagicLink(id(), cfg, '  New.Person@Example.SG ');
    expect(await sendMagicLink(id(), mailer, cfg, link.id)).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('new.person@example.sg');
    const token = tokenIn(mailer.sent[0]!);
    expect(token).toBe(magicLinkToken(cfg.secret, link.id));
    const { rows } = await owner.query(`select * from magic_links where id = $1`, [link.id]);
    expect(rows[0].token_hash).toEqual(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].sent_at).not.toBeNull();
    // Already sent: a second send does nothing.
    expect(await sendMagicLink(id(), mailer, cfg, link.id)).toBe(false);
  });

  it('signs in once; a reused, expired or made-up link creates no session (AC-2)', async () => {
    const mailer = fakeMailer();
    const link = await requestMagicLink(id(), cfg, 'once@example.sg');
    await sendMagicLink(id(), mailer, cfg, link.id);
    const token = tokenIn(mailer.sent[0]!);
    const first = await consumeMagicLink(id(), token);
    expect(first.next).toBe('create-workspace');
    const sessions = async () =>
      Number(
        (await owner.query(`select count(*) from sessions where user_id = $1`, [first.userId]))
          .rows[0].count,
      );
    expect(await sessions()).toBe(1);
    await expect(consumeMagicLink(id(), token)).rejects.toEqual(new LinkError('link_used'));

    const old = await requestMagicLink(id(), cfg, 'once@example.sg');
    await owner.query(
      `update magic_links set expires_at = now() - interval '1 second' where id = $1`,
      [old.id],
    );
    await expect(consumeMagicLink(id(), magicLinkToken(cfg.secret, old.id))).rejects.toEqual(
      new LinkError('link_expired'),
    );
    await expect(consumeMagicLink(id(), 'A'.repeat(43))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    await expect(consumeMagicLink(id(), 'not a token')).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    expect(await sessions()).toBe(1);
  });

  it('a link expires 15 minutes after it was requested', async () => {
    const link = await requestMagicLink(id(), cfg, 'ttl@example.sg');
    const { rows } = await owner.query(
      `select extract(epoch from expires_at - created_at)::int as s from magic_links where id = $1`,
      [link.id],
    );
    expect(rows[0].s).toBe(900);
  });

  it('two concurrent verifies of one link: exactly one wins', async () => {
    const link = await requestMagicLink(id(), cfg, 'race@example.sg');
    const token = magicLinkToken(cfg.secret, link.id);
    const results = await Promise.allSettled([
      consumeMagicLink(id(), token),
      consumeMagicLink(id(), token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('retries a failed send until it goes out, and never sends an expired link (AC-4)', async () => {
    const mailer = fakeMailer();
    mailer.setDown(true);
    const link = await requestMagicLink(id(), cfg, 'retry@example.sg');
    expect(await sendMagicLink(id(), mailer, cfg, link.id)).toBe(false);
    let row = (await owner.query(`select * from magic_links where id = $1`, [link.id])).rows[0];
    expect(row).toMatchObject({ sent_at: null, send_attempts: 1 });
    // Not due yet: the sweep leaves it.
    expect(await sendPendingMagicLinks(id(), mailer, cfg)).toMatchObject({ sent: 0, failed: 0 });
    await owner.query(`update magic_links set next_attempt_at = now() where id = $1`, [link.id]);
    expect(await sendPendingMagicLinks(id(), mailer, cfg)).toMatchObject({ sent: 0, failed: 1 });
    row = (await owner.query(`select * from magic_links where id = $1`, [link.id])).rows[0];
    expect(row.send_attempts).toBe(2);
    mailer.setDown(false);
    await owner.query(`update magic_links set next_attempt_at = now() where id = $1`, [link.id]);
    expect(await sendPendingMagicLinks(id(), mailer, cfg)).toMatchObject({ sent: 1 });
    expect(tokenIn(mailer.sent[0]!)).toBe(magicLinkToken(cfg.secret, link.id));
    // The re-derived token signs in.
    expect((await consumeMagicLink(id(), tokenIn(mailer.sent[0]!))).userId).toBeTruthy();

    const late = await requestMagicLink(id(), cfg, 'late@example.sg');
    await owner.query(
      `update magic_links set next_attempt_at = now(), expires_at = now() + interval '30 seconds' where id = $1`,
      [late.id],
    );
    expect(await sendPendingMagicLinks(id(), mailer, cfg)).toMatchObject({ sent: 0 });
    await owner.query(
      `update magic_links set expires_at = now() - interval '1 second' where id = $1`,
      [late.id],
    );
    expect(await sendMagicLink(id(), mailer, cfg, late.id)).toBe(false);
    expect(mailer.sent).toHaveLength(1);
  });

  it('a new link is left to the requester for 30 seconds before the sweep takes it', async () => {
    const mailer = fakeMailer();
    await requestMagicLink(id(), cfg, 'fresh@example.sg');
    expect(await sendPendingMagicLinks(id(), mailer, cfg)).toMatchObject({ sent: 0 });
  });

  it('purges links older than 24 hours', async () => {
    const mailer = fakeMailer();
    const old = await requestMagicLink(id(), cfg, 'old@example.sg');
    const recent = await requestMagicLink(id(), cfg, 'recent@example.sg');
    await owner.query(
      `update magic_links set created_at = now() - interval '25 hours' where id = $1`,
      [old.id],
    );
    expect((await sendPendingMagicLinks(id(), mailer, cfg)).purged).toBe(1);
    const { rows } = await owner.query(`select id from magic_links`);
    expect(rows.map((r) => r.id)).toEqual([recent.id]);
  });
});

describe('sessions (AUTH-02)', () => {
  it('an existing member opens their workspace (AC-8)', async () => {
    const s = await signIn('owner@kaki-bakery.test');
    expect(s.next).toBe('app');
    const r = await authenticate(id(), s.token);
    expect(r).toMatchObject({
      ok: true,
      auth: { tenantId: TENANT_A, role: 'owner', email: 'owner@kaki-bakery.test' },
    });
    const stored = await owner.query(`select token_hash from sessions where token_hash = $1`, [
      hashToken(s.token),
    ]);
    expect(stored.rowCount).toBe(1);
    const raw = await owner.query(`select count(*) from sessions where token_hash::text like $1`, [
      `%${s.token}%`,
    ]);
    expect(Number(raw.rows[0].count)).toBe(0);
  });

  it('expires after 12 hours idle or 30 days in all (AC-9)', async () => {
    const idle = await signIn('owner@kaki-bakery.test');
    await owner.query(
      `update sessions set last_seen_at = now() - interval '12 hours 1 second' where token_hash = $1`,
      [hashToken(idle.token)],
    );
    expect(await authenticate(id(), idle.token)).toEqual({ ok: false, reason: 'idle' });

    const active = await signIn('owner@kaki-bakery.test');
    await owner.query(
      `update sessions set last_seen_at = now() - interval '11 hours' where token_hash = $1`,
      [hashToken(active.token)],
    );
    expect((await authenticate(id(), active.token)).ok).toBe(true);
    // Use moved it forward.
    const seen = await owner.query(
      `select now() - last_seen_at < interval '1 minute' as fresh from sessions where token_hash = $1`,
      [hashToken(active.token)],
    );
    expect(seen.rows[0].fresh).toBe(true);

    const old = await signIn('owner@kaki-bakery.test');
    const { rows } = await owner.query(
      `select extract(epoch from expires_at - created_at)::int as s from sessions where token_hash = $1`,
      [hashToken(old.token)],
    );
    expect(rows[0].s).toBe(30 * 24 * 3600);
    await owner.query(
      `update sessions set expires_at = now() - interval '1 second' where token_hash = $1`,
      [hashToken(old.token)],
    );
    expect(await authenticate(id(), old.token)).toEqual({ ok: false, reason: 'expired' });
    expect(await authenticate(id(), undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await authenticate(id(), 'B'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });
  });

  it('sign out ends one session; sign out everywhere ends all of the user’s (AC-10)', async () => {
    const a = await signIn('owner@kaki-bakery.test');
    const b = await signIn('owner@kaki-bakery.test');
    const other = await signIn('owner@second-tenant.test');
    const ra = await authenticate(id(), a.token);
    if (!ra.ok) throw new Error('expected a session');
    await revokeSession(id(), ra.auth.sessionId);
    expect(await authenticate(id(), a.token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await authenticate(id(), b.token)).ok).toBe(true);
    expect((await revokeAllSessions(id(), ra.auth.userId)).length).toBeGreaterThan(0);
    expect(await authenticate(id(), b.token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await authenticate(id(), other.token)).ok).toBe(true);
  });

  it('deactivation, role change and a disabled user apply on the next request (AC-11)', async () => {
    const userId = (
      await owner.query(`insert into users (email) values ('staff@kaki-bakery.test') returning id`)
    ).rows[0].id;
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`,
      [TENANT_A, userId],
    );
    const s = await signIn('staff@kaki-bakery.test');
    expect(await authenticate(id(), s.token)).toMatchObject({
      ok: true,
      auth: { role: 'agent', tenantId: TENANT_A },
    });
    await owner.query(`update memberships set role = 'admin' where user_id = $1`, [userId]);
    expect(await authenticate(id(), s.token)).toMatchObject({ ok: true, auth: { role: 'admin' } });
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [userId]);
    expect(await authenticate(id(), s.token)).toMatchObject({
      ok: true,
      auth: { role: null, tenantId: null },
    });
    await owner.query(`update users set status = 'disabled' where id = $1`, [userId]);
    expect(await authenticate(id(), s.token)).toEqual({ ok: false, reason: 'user_disabled' });
    // A disabled user can't start a new session either.
    const mailer = fakeMailer();
    const link = await requestMagicLink(id(), cfg, 'staff@kaki-bakery.test');
    await sendMagicLink(id(), mailer, cfg, link.id);
    await expect(consumeMagicLink(id(), tokenIn(mailer.sent[0]!))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
  });
});

describe('workspaces (ONB-01, AUTH-08)', () => {
  it('creates the tenant, owner membership, acceptances and audit entries (AC-6)', async () => {
    const s = await signIn('founder@newbiz.sg');
    expect(s.next).toBe('create-workspace');
    const before = await authenticate(id(), s.token);
    if (!before.ok) throw new Error('expected a session');
    expect(before.auth.tenantId).toBeNull();

    const ws = await createWorkspace(id(), before.auth, {
      businessName: '  Newbiz Florist ',
      accepted: current,
    });
    expect(ws).toMatchObject({ name: 'Newbiz Florist', status: 'active' });
    expect(await authenticate(id(), s.token)).toMatchObject({
      ok: true,
      auth: { tenantId: ws.id, role: 'owner' },
    });

    const t = (await owner.query(`select * from tenants where id = $1`, [ws.id])).rows[0];
    expect(t.slug).toMatch(/^newbiz-florist-[a-z0-9]{6}$/);
    expect(t.widget_key).toMatch(/^wk_[A-Za-z0-9_-]{24}$/);
    expect(
      (await owner.query(`select 1 from business_profiles where tenant_id = $1`, [ws.id])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`select position from widget_settings where tenant_id = $1`, [ws.id]))
        .rows,
    ).toEqual([{ position: 'right' }]);
    const acc = await owner.query(
      `select document, version, user_id, accepted_at from terms_acceptances where tenant_id = $1 order by document`,
      [ws.id],
    );
    expect(acc.rows.map((r) => [r.document, r.version, r.user_id])).toEqual([
      ['aup', current.aup, before.auth.userId],
      ['dpa', current.dpa, before.auth.userId],
      ['tos', current.tos, before.auth.userId],
    ]);
    expect(acc.rows.every((r) => r.accepted_at instanceof Date)).toBe(true);
    const audit = await owner.query(
      `select event_type, payload from audit_entries where tenant_id = $1 order by seq`,
      [ws.id],
    );
    expect(audit.rows).toEqual([
      { event_type: 'tenant.created', payload: {} },
      { event_type: 'terms.accepted', payload: current },
    ]);
    expect((await verifyChain(tdb.zone('dashboard'), ws.id)).ok).toBe(true);

    // The next sign-in opens the new workspace.
    expect((await signIn('founder@newbiz.sg')).next).toBe('app');
  });

  it('outdated terms create nothing; the user stays signed in without a workspace (AC-7)', async () => {
    const s = await signIn('hesitant@newbiz.sg');
    const r = await authenticate(id(), s.token);
    if (!r.ok) throw new Error('expected a session');
    const count = async () =>
      Number((await owner.query(`select count(*) from tenants`)).rows[0].count);
    const n = await count();
    await expect(
      createWorkspace(id(), r.auth, {
        businessName: 'X',
        accepted: { ...current, dpa: '2020-01-01' },
      }),
    ).rejects.toBeInstanceOf(TermsOutdatedError);
    expect(await count()).toBe(n);
    expect(await authenticate(id(), s.token)).toMatchObject({ ok: true, auth: { tenantId: null } });
    expect((await signIn('hesitant@newbiz.sg')).next).toBe('create-workspace');
  });
});
