/**
 * Workers (FEAT-061 §5.6; AC-6, AC-8): the `dsr_objects` job removes the attachment files and
 * marks the request's files done once (a re-run is a no-op), and the due sweep alerts Owners and
 * Admins once per request at due − 7, never for closed requests, and can't be muted (D8).
 */
import { muteEvent } from '@kaki/platform/notifications';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueDsrDueAlerts, removeDsrObjects } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const q = async (text: string, args: unknown[] = []) => (await owner.query(text, args)).rows;
const sgToday = `(now() at time zone 'Asia/Singapore')::date`;

/** A request received `ageDays` ago (due 30 days after receipt). */
async function seedRequest(
  t: string,
  ageDays: number,
  status: 'open' | 'verified' | 'closed' | 'completed' = 'open',
  objectsPending = 0,
): Promise<string> {
  const closed = status === 'closed' || status === 'completed';
  const [row] = await q(
    `insert into dsr_requests (tenant_id, type, status, source, received_on, requester_email,
       verify_method, verified_at, close_reason, closed_at, objects_pending)
     values ($1, 'deletion', $2, 'dashboard', ${sgToday} - $3::int, 'mei@example.com',
       case when $2 = 'verified' then 'email_reply' end, case when $2 = 'verified' then now() end,
       case when $2 = 'closed' then 'duplicate' end, case when $4 then now() end, $5)
     returning id`,
    [t, status, ageDays, closed, objectsPending],
  );
  return row.id as string;
}

describe('removeDsrObjects (AC-6)', () => {
  it('deletes the keys, marks the files done and audits once; a re-run changes nothing', async () => {
    const id = await seedRequest(TENANT_A, 1, 'completed', 3);
    const keys = ['attachments/a/1', 'attachments/a/2', 'attachments/a/3'];
    const deleted: string[][] = [];
    const store = { deleteKeys: async (k: string[]) => void deleted.push(k) };
    const job = { kind: 'dsr_objects' as const, tenantId: TENANT_A, requestId: id, keys };

    expect(await removeDsrObjects(tdb.zone('visitor'), store, job)).toBe('removed');
    expect(deleted).toEqual([keys]);
    const [row] = await q(
      `select objects_pending, objects_done_at from dsr_requests where tenant_id = $1 and id = $2`,
      [TENANT_A, id],
    );
    expect(row.objects_pending).toBe(0);
    expect(row.objects_done_at).not.toBeNull();
    const audits = async () =>
      q(
        `select payload from audit_entries where tenant_id = $1 and event_type = 'dsr.objects_removed'
           and ('data_request:' || $2) = any(subject_refs)`,
        [TENANT_A, id],
      );
    expect((await audits()).map((r) => r.payload)).toEqual([{ count: 3 }]);

    expect(await removeDsrObjects(tdb.zone('visitor'), store, job)).toBe('already_done');
    expect(deleted).toHaveLength(2);
    expect(await audits()).toHaveLength(1);
  });

  it("can't mark another tenant's request", async () => {
    const id = await seedRequest(TENANT_B, 1, 'completed', 1);
    const store = { deleteKeys: async () => {} };
    const out = await removeDsrObjects(tdb.zone('visitor'), store, {
      kind: 'dsr_objects',
      tenantId: TENANT_A,
      requestId: id,
      keys: ['k'],
    });
    expect(out).toBe('already_done');
    const [row] = await q(`select objects_pending from dsr_requests where id = $1`, [id]);
    expect(row.objects_pending).toBe(1);
  });
});

describe('queueDsrDueAlerts (AC-8, D8)', () => {
  it('alerts Owners and Admins once per request from due − 7; none for closed or later ones', async () => {
    const dueIn7 = await seedRequest(TENANT_A, 23); // due in 7 days
    const verifiedOverdue = await seedRequest(TENANT_A, 31, 'verified');
    const dueIn8 = await seedRequest(TENANT_A, 22);
    const closed = await seedRequest(TENANT_A, 29, 'closed');
    const tenantB = await seedRequest(TENANT_B, 25);

    expect(await queueDsrDueAlerts(tdb.zone('outbox'))).toBe(3);
    const alerts = await q(
      `select tenant_id, user_id, subject_id from notifications
        where kind = 'dsr_due_soon' and subject_type = 'data_request' and channel = 'email'`,
    );
    const admins = async (t: string) =>
      (
        await q(
          `select user_id from memberships where tenant_id = $1 and status = 'active'
             and role in ('owner', 'admin') order by user_id`,
          [t],
        )
      ).map((r) => r.user_id as string);
    const to = (id: string) =>
      alerts
        .filter((a) => a.subject_id === id)
        .map((a) => a.user_id as string)
        .sort();
    expect(to(dueIn7)).toEqual(await admins(TENANT_A));
    expect(to(verifiedOverdue)).toEqual(await admins(TENANT_A));
    expect(to(tenantB)).toEqual(await admins(TENANT_B));
    expect(alerts.find((a) => a.subject_id === tenantB)?.tenant_id).toBe(TENANT_B);
    expect(to(dueIn8)).toEqual([]);
    expect(to(closed)).toEqual([]);

    // Once per request: the next sweep queues nothing.
    expect(await queueDsrDueAlerts(tdb.zone('outbox'))).toBe(0);
    const again = await q(`select count(*)::int n from notifications where kind = 'dsr_due_soon'`);
    expect(again[0].n).toBe(alerts.length);
    // A legal deadline: no member preference mutes it.
    expect(muteEvent('dsr_due_soon')).toBeNull();
  });
});
