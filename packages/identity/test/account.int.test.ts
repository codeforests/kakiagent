/**
 * My account on the real schema, as the identity zone (FEAT-008 T2; AC-1–AC-5, AC-7).
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { verifyChain } from '@kaki/governance';
import type { Email, Mailer } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountError,
  authenticate,
  cancelEmailChange,
  confirmEmailChange,
  consumeMagicLink,
  emailChangeToken,
  getAccount,
  LinkError,
  listSessions,
  listTeam,
  requestEmailChange,
  requestMagicLink,
  revokeAllSessions,
  revokeOwnSession,
  sendEmailChange,
  sendMagicLink,
  sendPendingEmailChanges,
  updateProfile,
  type MagicLinkConfig,
} from '../src/index.js';
import { withTenant } from '@kaki/db';

const cfg: MagicLinkConfig = { secret: 'm'.repeat(32), appUrl: 'http://localhost:5173' };
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

let tdb: TestDatabase;
let owner: pg.Client;
const id = () => tdb.zone('identity');
let n = 0;
const fresh = () => `acct${++n}@example.test`;

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

async function signIn(email: string, userAgent?: string) {
  const mailer = fakeMailer();
  const link = await requestMagicLink(id(), cfg, email);
  await sendMagicLink(id(), mailer, cfg, link.id);
  const s = await consumeMagicLink(id(), tokenIn(mailer.sent[0]!), null, userAgent);
  if (s.next === 'reauthed') throw new Error('expected a sign-in');
  const r = await authenticate(id(), s.token);
  if (!r.ok) throw new Error('expected a session');
  return { token: s.token, auth: r.auth };
}

/** A user who is an Agent at tenant A, so account events have a chain to land in. */
async function member(email: string) {
  const s = await signIn(email);
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    s.auth.userId,
  ]);
  return s;
}

/** Request a change and send its emails now; returns the two captured emails. */
async function request(userId: string, newEmail: string) {
  const mailer = fakeMailer();
  const { id: changeId } = await requestEmailChange(id(), cfg, userId, newEmail);
  expect(await sendEmailChange(id(), mailer, cfg, changeId)).toBe(true);
  const toNew = mailer.sent.find((e) => e.to === newEmail.trim().toLowerCase())!;
  const notice = mailer.sent.find((e) => e.to !== newEmail.trim().toLowerCase())!;
  return { changeId, toNew, notice, mailer };
}

const emailOf = async (userId: string) =>
  (await owner.query(`select email, google_sub from users where id = $1`, [userId])).rows[0];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('profile name (AC-1)', () => {
  it('sets and clears the name; Me and the team list carry it', async () => {
    const s = await member(fresh());
    expect((await updateProfile(id(), s.auth.userId, 'Mei Ling')).displayName).toBe('Mei Ling');
    const again = await authenticate(id(), s.token);
    expect(again.ok && again.auth.displayName).toBe('Mei Ling');
    const team = await withTenant(id(), TENANT_A, (tx) => listTeam(tx, s.auth.userId));
    expect(team.members.find((m) => m.userId === s.auth.userId)?.displayName).toBe('Mei Ling');
    expect((await updateProfile(id(), s.auth.userId, null)).displayName).toBeNull();
  });
});

describe('email change (AC-2–AC-4)', () => {
  it('request leaves the email as it is and sends the link and the notice', async () => {
    const oldEmail = fresh();
    const s = await member(oldEmail);
    const newEmail = fresh();
    const { toNew, notice } = await request(s.auth.userId, ` ${newEmail.toUpperCase()} `);
    expect((await emailOf(s.auth.userId)).email).toBe(oldEmail);
    expect(toNew.text).toMatch(/\/verify-email#token=/);
    expect(notice.to).toBe(oldEmail);
    expect(notice.text).toContain('a***@example.test');
    expect(notice.text).not.toContain(newEmail);
    const acct = await getAccount(id(), s.auth.userId);
    expect(acct.email).toBe(oldEmail);
    expect(acct.pendingEmail).toMatchObject({ email: newEmail, delivery: 'sent' });
    // Until confirmed, sign-in still uses the old address, and the new one is another user.
    expect((await signIn(oldEmail)).auth.userId).toBe(s.auth.userId);
    expect((await signIn(newEmail)).auth.userId).not.toBe(s.auth.userId);
  });

  it('confirm moves the email, clears Google, kills old sign-in links; once only', async () => {
    const oldEmail = fresh();
    const s = await member(oldEmail);
    await owner.query(`update users set google_sub = 'g-123' where id = $1`, [s.auth.userId]);
    const pendingLink = await requestMagicLink(id(), cfg, oldEmail);
    const newEmail = fresh();
    const { toNew } = await request(s.auth.userId, newEmail);
    expect(await confirmEmailChange(id(), tokenIn(toNew))).toEqual({ email: newEmail });
    expect(await emailOf(s.auth.userId)).toEqual({ email: newEmail, google_sub: null });
    const left = await owner.query(`select 1 from magic_links where id = $1`, [pendingLink.id]);
    expect(left.rows).toHaveLength(0);
    await expect(confirmEmailChange(id(), tokenIn(toNew))).rejects.toEqual(
      new LinkError('link_used'),
    );
    // Sessions stay signed in (D9), now under the new address.
    const still = await authenticate(id(), s.token);
    expect(still.ok && still.auth.email).toBe(newEmail);
    expect((await getAccount(id(), s.auth.userId)).pendingEmail).toBeNull();
  });

  it('an expired, replaced, cancelled or made-up link is refused', async () => {
    const s = await member(fresh());
    const first = await request(s.auth.userId, fresh());
    const second = await request(s.auth.userId, fresh());
    await expect(confirmEmailChange(id(), tokenIn(first.toNew))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    await cancelEmailChange(id(), s.auth.userId);
    await cancelEmailChange(id(), s.auth.userId); // idempotent
    await expect(confirmEmailChange(id(), tokenIn(second.toNew))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    const third = await request(s.auth.userId, fresh());
    await owner.query(`update email_changes set expires_at = now() where id = $1`, [
      third.changeId,
    ]);
    await expect(confirmEmailChange(id(), tokenIn(third.toNew))).rejects.toEqual(
      new LinkError('link_expired'),
    );
    await expect(confirmEmailChange(id(), 'x'.repeat(43))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    await expect(confirmEmailChange(id(), 'short')).rejects.toEqual(new LinkError('link_invalid'));
  });

  it('the same address is refused', async () => {
    const email = fresh();
    const s = await member(email);
    await expect(requestEmailChange(id(), cfg, s.auth.userId, email.toUpperCase())).rejects.toEqual(
      new AccountError('same_email'),
    );
  });

  it('an address taken at request gets no link and can never be confirmed (D5)', async () => {
    const other = fresh();
    await signIn(other);
    const s = await member(fresh());
    const { changeId, toNew } = await request(s.auth.userId, other);
    expect(toNew.text).not.toMatch(/token=/);
    expect(toNew.subject).toMatch(/already has/);
    await expect(confirmEmailChange(id(), emailChangeToken(cfg.secret, changeId))).rejects.toEqual(
      new LinkError('link_invalid'),
    );
    // The answer doesn't reveal it: the view looks like any pending request.
    expect((await getAccount(id(), s.auth.userId)).pendingEmail?.email).toBe(other);
  });

  it('an address taken between request and confirm is refused with nothing changed', async () => {
    const oldEmail = fresh();
    const s = await member(oldEmail);
    const newEmail = fresh();
    const { toNew } = await request(s.auth.userId, newEmail);
    await signIn(newEmail);
    await expect(confirmEmailChange(id(), tokenIn(toNew))).rejects.toEqual(
      new AccountError('email_taken'),
    );
    expect((await emailOf(s.auth.userId)).email).toBe(oldEmail);
    // The claim rolled back with it.
    const { rows } = await owner.query(
      `select confirmed_at from email_changes where user_id = $1`,
      [s.auth.userId],
    );
    expect(rows[0].confirmed_at).toBeNull();
  });

  it('a failed send is queued and retried by the sweep, once per worker (SKIP LOCKED)', async () => {
    const s = await member(fresh());
    const newEmail = fresh();
    const down = fakeMailer();
    down.setDown(true);
    const { id: changeId } = await requestEmailChange(id(), cfg, s.auth.userId, newEmail);
    expect(await sendEmailChange(id(), down, cfg, changeId)).toBe(false);
    expect((await getAccount(id(), s.auth.userId)).pendingEmail?.delivery).toBe('queued');
    await owner.query(`update email_changes set next_attempt_at = now() where id = $1`, [changeId]);
    const up = fakeMailer();
    const [a, b] = await Promise.all([
      sendPendingEmailChanges(id(), up, cfg),
      sendPendingEmailChanges(id(), up, cfg),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(up.sent.map((e) => e.to).sort()).toEqual([newEmail, s.auth.email].sort());
    expect((await getAccount(id(), s.auth.userId)).pendingEmail?.delivery).toBe('sent');
    expect((await sendPendingEmailChanges(id(), up, cfg)).sent).toBe(0);
  });

  it('the sweep purges requests ended more than 7 days ago (D7)', async () => {
    const s = await member(fresh());
    const { changeId } = await request(s.auth.userId, fresh());
    await cancelEmailChange(id(), s.auth.userId);
    await owner.query(
      `update email_changes set cancelled_at = now() - interval '8 days' where id = $1`,
      [changeId],
    );
    expect((await sendPendingEmailChanges(id(), fakeMailer(), cfg)).purged).toBeGreaterThan(0);
    const { rows } = await owner.query(`select 1 from email_changes where id = $1`, [changeId]);
    expect(rows).toHaveLength(0);
  });
});

describe('devices (AC-5)', () => {
  it('lists live sessions with labels, this one first', async () => {
    const email = fresh();
    const a = await signIn(email, CHROME_WIN);
    const b = await signIn(email, SAFARI_IPHONE);
    const c = await signIn(email);
    await revokeAllSessions(id(), 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    await owner.query(
      `update sessions set last_seen_at = now() - interval '13 hours' where id = $1`,
      [c.auth.sessionId],
    );
    const list = await listSessions(id(), a.auth.userId, b.auth.sessionId);
    expect(list.map((d) => [d.device, d.current, d.authMethod])).toEqual([
      ['Safari on iPhone', true, 'magic_link'],
      ['Chrome on Windows', false, 'magic_link'],
    ]);
    const ua = await owner.query(`select user_agent from sessions where id = $1`, [
      a.auth.sessionId,
    ]);
    expect(ua.rows[0].user_agent).toBe(CHROME_WIN);
  });

  it('signs out another device; never this one or someone else’s', async () => {
    const email = fresh();
    const a = await member(email);
    const b = await signIn(email);
    const stranger = await signIn(fresh());
    await expect(
      revokeOwnSession(id(), a.auth.userId, a.auth.sessionId, a.auth.sessionId),
    ).rejects.toEqual(new AccountError('current_session'));
    await expect(
      revokeOwnSession(id(), a.auth.userId, stranger.auth.sessionId, a.auth.sessionId),
    ).rejects.toEqual(new AccountError('not_found'));
    expect((await authenticate(id(), stranger.token)).ok).toBe(true);
    await revokeOwnSession(id(), a.auth.userId, b.auth.sessionId, a.auth.sessionId);
    expect(await authenticate(id(), b.token)).toEqual({ ok: false, reason: 'revoked' });
    await expect(
      revokeOwnSession(id(), a.auth.userId, b.auth.sessionId, a.auth.sessionId),
    ).rejects.toEqual(new AccountError('not_found'));
    const ids = await revokeAllSessions(id(), a.auth.userId);
    expect(ids).toEqual([a.auth.sessionId]);
  });

  it('a long user agent is cut to 256 characters', async () => {
    const s = await signIn(fresh(), 'x'.repeat(1000));
    const { rows } = await owner.query(`select user_agent from sessions where id = $1`, [
      s.auth.sessionId,
    ]);
    expect(rows[0].user_agent).toHaveLength(256);
  });
});

describe('audit (AC-7)', () => {
  it('account events carry IDs only, and the chain holds', async () => {
    const email = fresh();
    const s = await member(email);
    const other = await signIn(email);
    await updateProfile(id(), s.auth.userId, 'Ah Kow');
    const newEmail = fresh();
    const { toNew } = await request(s.auth.userId, newEmail);
    await cancelEmailChange(id(), s.auth.userId);
    const again = await request(s.auth.userId, fresh());
    await confirmEmailChange(id(), tokenIn(again.toNew));
    await revokeOwnSession(id(), s.auth.userId, other.auth.sessionId, s.auth.sessionId);
    expect(toNew).toBeDefined();
    const { rows } = await owner.query(
      `select event_type, payload::text as payload from audit_entries
       where tenant_id = $1 and actor_ref = $2 order by seq`,
      [TENANT_A, s.auth.userId],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      'account.name_changed',
      'account.email_change_requested',
      'account.email_change_cancelled',
      'account.email_change_requested',
      'account.email_changed',
      'session.revoked',
    ]);
    for (const r of rows) expect(r.payload).toBe('{}');
    const all = JSON.stringify(
      (await owner.query(`select * from audit_entries where actor_ref = $1`, [s.auth.userId])).rows,
    );
    expect(all).not.toContain('example.test');
    expect(all).not.toContain('Ah Kow');
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});
