import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Email, Mailer } from '../src/mailer.js';
import {
  cancelNotifications,
  fromClock,
  getPrefs,
  notify,
  savePrefs,
  sendDueNotifications,
  type NotificationKind,
} from '../src/notifications/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let ownerA: string;
let agentA: string;
let ownerB: string;
const APP = 'https://app.test';

/** A UTC instant for a Singapore wall-clock time on 2026-11-01 (UTC+8). */
const sg = (clock: string, plusDays = 0) =>
  new Date(Date.UTC(2026, 10, 1 + plusDays, 0, 0) + (fromClock(clock) - 8 * 60) * 60_000);

function fakeMailer(failTimes = 0) {
  const sent: Email[] = [];
  let failures = failTimes;
  const mailer: Mailer = {
    async send(e) {
      if (failures-- > 0) throw new Error('smtp down');
      sent.push(e);
    },
    async close() {},
  };
  return { mailer, sent, recover: () => (failures = 0) };
}

const alert = (
  kind: NotificationKind,
  recipients: string[],
  over: { urgent?: boolean; id?: string; key?: string; tenant?: string } = {},
) => {
  const tenantId = over.tenant ?? TENANT_A;
  const id = over.id ?? randomUUID();
  return withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    notify(tx, {
      tenantId,
      kind,
      recipients,
      urgent: over.urgent ?? false,
      subject: { type: kind === 'test' ? 'user' : 'conversation', id },
      dedupeKey: over.key ?? `${kind}:${id}`,
    }),
  );
};

/** Rows are created at the real now(); move them to `at` so the injected clock fits. */
const backdate = (at: Date) =>
  owner.query(`update notifications set created_at = $1, next_attempt_at = $1`, [at]);

const statuses = async () =>
  (
    await owner.query<{
      user_id: string;
      kind: string;
      status: string;
      skip_reason: string | null;
    }>(`select user_id, kind, status, skip_reason from notifications order by created_at`)
  ).rows;

const setPrefs = (
  userId: string,
  p: { muted?: string[]; quiet?: [string, string] | null },
  tenant = TENANT_A,
) =>
  owner.query(
    `insert into notification_prefs (tenant_id, user_id, email_muted, quiet_enabled, quiet_start, quiet_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, user_id) do update set email_muted = excluded.email_muted,
       quiet_enabled = excluded.quiet_enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end`,
    [
      tenant,
      userId,
      p.muted ?? [],
      p.quiet !== null,
      fromClock(p.quiet?.[0] ?? '22:00'),
      fromClock(p.quiet?.[1] ?? '08:00'),
    ],
  );

const send = (mailer: Mailer, now: Date) =>
  sendDueNotifications(tdb.zone('identity'), mailer, { appUrl: APP, now });

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const ids = await owner.query<{ email: string; id: string }>(`select email, id from users`);
  const id = (e: string) => ids.rows.find((r) => r.email === e)!.id;
  ownerA = id('owner@kaki-bakery.test');
  agentA = (
    await owner.query<{ id: string }>(
      `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
    )
  ).rows[0]!.id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    agentA,
  ]);
  ownerB = id('owner@second-tenant.test');
});

afterEach(async () => {
  await owner.query(`delete from notifications`);
  await owner.query(`delete from notification_prefs`);
  await owner.query(`update memberships set status = 'active'`);
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('notify and cancel (FEAT-052 §5.1; AC-7)', () => {
  it('one row per distinct recipient; a retried producer with the same key alerts once', async () => {
    const id = randomUUID();
    expect(await alert('escalation', [ownerA, agentA, ownerA], { id })).toBe(2);
    expect(await alert('escalation', [ownerA, agentA], { id })).toBe(0);
    expect(await alert('escalation', [], { id: randomUUID() })).toBe(0);
    expect(await statuses()).toHaveLength(2);
  });

  it('the visitor zone can notify too (producers write from their own zone)', async () => {
    const n = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      notify(tx, {
        tenantId: TENANT_A,
        kind: 'hot_lead',
        recipients: [ownerA],
        subject: { type: 'lead', id: randomUUID() },
        dedupeKey: 'lead:1',
      }),
    );
    expect(n).toBe(1);
  });

  it('cancel stops pending and held alerts for a subject, optionally of one kind', async () => {
    const id = randomUUID();
    await alert('escalation', [ownerA, agentA], { id });
    await alert('hot_lead', [ownerA], { id });
    await owner.query(`update notifications set status = 'held' where user_id = $1`, [agentA]);
    const dash = tdb.zone('dashboard');
    const subject = { type: 'conversation' as const, id };
    expect(
      await withTenant(dash, TENANT_A, (tx) =>
        cancelNotifications(tx, TENANT_A, subject, 'escalation'),
      ),
    ).toBe(2);
    expect((await statuses()).map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'pending']);
    expect(
      await withTenant(dash, TENANT_A, (tx) => cancelNotifications(tx, TENANT_A, subject)),
    ).toBe(1);
  });
});

describe('preferences (FEAT-052 §5.1; AC-5, AC-6)', () => {
  it('defaults without a row; a save merges listed events and keeps unlisted ones', async () => {
    const dash = tdb.zone('dashboard');
    const read = () => withTenant(dash, TENANT_A, (tx) => getPrefs(tx, TENANT_A, ownerA));
    expect(await read()).toEqual({
      emailMuted: [],
      quiet: { enabled: true, start: 1320, end: 480 },
    });
    const quiet = { enabled: true, start: fromClock('23:00'), end: fromClock('07:00') };
    await withTenant(dash, TENANT_A, (tx) =>
      savePrefs(tx, TENANT_A, ownerA, {
        events: [
          { event: 'escalation', email: false },
          { event: 'hot_lead', email: false },
        ],
        quiet,
      }),
    );
    await withTenant(dash, TENANT_A, (tx) =>
      savePrefs(tx, TENANT_A, ownerA, { events: [{ event: 'hot_lead', email: true }], quiet }),
    );
    expect(await read()).toEqual({ emailMuted: ['escalation'], quiet });
    // Per business: tenant B's row for another member is untouched and separate.
    const b = await withTenant(dash, TENANT_B, (tx) => getPrefs(tx, TENANT_B, ownerB));
    expect(b.emailMuted).toEqual([]);
  });
});

describe('sender (FEAT-052 §5.2)', () => {
  it('AC-1: sends outside quiet hours, naming the business and linking to the item', async () => {
    const { mailer, sent } = fakeMailer();
    const id = randomUUID();
    await alert('escalation', [ownerA], { id });
    await backdate(sg('10:00'));
    const r = await send(mailer, sg('10:00'));
    expect(r).toMatchObject({ sent: 1, held: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner@kaki-bakery.test');
    expect(sent[0]!.subject).toMatch(/^\[.+\] A customer wants to talk to a person$/);
    expect(sent[0]!.text).toContain(`${APP}/inbox/${id}`);
    expect(await statuses()).toMatchObject([{ status: 'sent' }]);
    // A second tick sends nothing more.
    expect((await send(mailer, sg('10:00'))).sent).toBe(0);
  });

  it('AC-2, AC-3: holds non-urgent alerts in quiet hours; urgent ones go at once', async () => {
    const { mailer, sent } = fakeMailer();
    await alert('escalation', [ownerA]);
    await alert('approval_pending', [ownerA], { urgent: true });
    await backdate(sg('23:00'));
    const r = await send(mailer, sg('23:00'));
    expect(r).toMatchObject({ sent: 1, held: 1 });
    expect(sent.map((e) => e.subject)).toEqual([
      expect.stringMatching(/^Urgent: \[.+\] A reply is waiting for your approval$/),
    ]);
  });

  it('AC-4: everything held goes out as one digest when quiet hours end; cancelled left out', async () => {
    const { mailer, sent } = fakeMailer();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await alert('escalation', [ownerA], { id });
    await backdate(sg('23:00'));
    expect((await send(mailer, sg('23:00'))).held).toBe(3);
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      cancelNotifications(tx, TENANT_A, { type: 'conversation', id: ids[1]! }),
    );
    expect((await send(mailer, sg('07:59', 1))).digests).toBe(0);
    const r = await send(mailer, sg('08:00', 1));
    expect(r).toMatchObject({ digests: 1, sent: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/2 alerts while your quiet hours were on$/);
    expect(sent[0]!.text).toContain(ids[0]);
    expect(sent[0]!.text).not.toContain(ids[1]);
    expect((await send(mailer, sg('08:01', 1))).digests).toBe(0);
  });

  it('AC-4: turning quiet hours off releases the digest at the next tick', async () => {
    const { mailer, sent } = fakeMailer();
    await alert('hot_lead', [ownerA]);
    await backdate(sg('23:00'));
    await send(mailer, sg('23:00'));
    await setPrefs(ownerA, { quiet: null });
    expect((await send(mailer, sg('23:01'))).digests).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('AC-4: all held alerts cancelled → no email', async () => {
    const { mailer, sent } = fakeMailer();
    const id = randomUUID();
    await alert('escalation', [ownerA], { id });
    await backdate(sg('23:00'));
    await send(mailer, sg('23:00'));
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      cancelNotifications(tx, TENANT_A, { type: 'conversation', id }),
    );
    expect(await send(mailer, sg('09:00', 1))).toMatchObject({ digests: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it('AC-5: a muted event is skipped; the test alert ignores mutes and quiet hours', async () => {
    const { mailer, sent } = fakeMailer();
    await setPrefs(ownerA, { muted: ['escalation'] });
    await alert('escalation', [ownerA]);
    await alert('hot_lead', [ownerA]);
    await alert('test', [ownerA], { id: ownerA, key: 'test:1' });
    await backdate(sg('23:00'));
    const r = await send(mailer, sg('23:00'));
    expect(r).toMatchObject({ skipped: 1, held: 1, sent: 1 });
    expect(await statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'escalation', status: 'skipped', skip_reason: 'muted' }),
        expect.objectContaining({ kind: 'hot_lead', status: 'held' }),
        expect.objectContaining({ kind: 'test', status: 'sent' }),
      ]),
    );
    expect(sent[0]!.subject).toMatch(/Test alert from KakiAgent$/);
    expect(sent[0]!.text).toContain(`${APP}/account/notifications`);
  });

  it('AC-7: an alert for a member who was deactivated is not sent', async () => {
    const { mailer, sent } = fakeMailer();
    await alert('escalation', [agentA]);
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [agentA]);
    await backdate(sg('10:00'));
    expect((await send(mailer, sg('10:00'))).skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await statuses()).toMatchObject([{ status: 'skipped', skip_reason: 'inactive' }]);
  });

  it('AC-8: a provider failure is retried with backoff and sent once it recovers', async () => {
    const { mailer, sent } = fakeMailer(2);
    await alert('escalation', [ownerA]);
    await backdate(sg('10:00'));
    await send(mailer, sg('10:00'));
    expect((await send(mailer, sg('10:00'))).sent).toBe(0); // not due yet: backoff
    const next = await owner.query<{ attempts: number; next_attempt_at: Date }>(
      `select attempts, next_attempt_at from notifications`,
    );
    expect(next.rows[0]!.attempts).toBe(1);
    expect(next.rows[0]!.next_attempt_at).toEqual(new Date(sg('10:00').getTime() + 10_000));
    await send(mailer, sg('10:01'));
    expect((await send(mailer, sg('10:05'))).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('AC-8: still failing 24 hours after it was created → failed and logged', async () => {
    const { mailer } = fakeMailer(1000);
    const warnings: object[] = [];
    await alert('escalation', [ownerA]);
    await backdate(sg('10:00'));
    const r = await sendDueNotifications(tdb.zone('identity'), mailer, {
      appUrl: APP,
      now: sg('10:00', 1),
      log: { warn: (o) => warnings.push(o) },
    });
    expect(r.failed).toBe(1);
    expect(await statuses()).toMatchObject([{ status: 'failed' }]);
    expect(Object.keys(warnings[0]!).sort()).toEqual(['kind', 'notificationId', 'tenantId']);
  });

  it('AC-8: two senders in parallel email each alert once', async () => {
    const { mailer, sent } = fakeMailer();
    for (let i = 0; i < 6; i++) await alert('hot_lead', [ownerA, agentA]);
    await alert('hot_lead', [ownerB], { tenant: TENANT_B });
    await backdate(sg('10:00'));
    const slowMailer: Mailer = {
      async send(e) {
        await new Promise((r) => setTimeout(r, 5));
        await mailer.send(e);
      },
      async close() {},
    };
    const [a, b] = await Promise.all([
      send(slowMailer, sg('10:00')),
      send(slowMailer, sg('10:00')),
    ]);
    expect(a.sent + b.sent).toBe(13);
    expect(sent).toHaveLength(13);
  });

  it('purges ended rows after 30 days and keeps live ones', async () => {
    const { mailer } = fakeMailer();
    await alert('escalation', [ownerA]);
    await alert('hot_lead', [ownerA]);
    await owner.query(
      `update notifications set status = 'sent', created_at = $1 where kind = 'escalation'`,
      [sg('10:00', -31)],
    );
    await owner.query(
      `update notifications set status = 'held', created_at = $1, next_attempt_at = $1 where kind = 'hot_lead'`,
      [sg('10:00', -31)],
    );
    await setPrefs(ownerA, {});
    const r = await send(mailer, sg('23:00'));
    expect(r.purged).toBe(1);
    expect(await statuses()).toMatchObject([{ kind: 'hot_lead', status: 'held' }]);
  });
});

describe('tenant isolation', () => {
  it("tenant B's dashboard context can't notify into or cancel tenant A", async () => {
    const id = randomUUID();
    await alert('escalation', [ownerA], { id });
    const n = await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
      cancelNotifications(tx, TENANT_A, { type: 'conversation', id }),
    );
    expect(n).toBe(0);
    await expect(
      withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
        notify(tx, {
          tenantId: TENANT_A,
          kind: 'escalation',
          recipients: [ownerA],
          subject: { type: 'conversation', id },
          dedupeKey: 'x',
        }),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  });
});
