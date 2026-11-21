/**
 * Data-subject request lifecycle (FEAT-061 §5.1; AC-1, AC-2): due date, transitions with a
 * version check, notes masked, audit entries without requester values, tenant isolation.
 */
import { DsrCreateBody, sgToday } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  closeRequest,
  completeRequest,
  createRequest,
  DsrError,
  getRequest,
  listRequests,
  markUnverified,
  requestEvents,
  toDetail,
  updateRequest,
  verifyChain,
  verifyRequest,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const body = (over: Record<string, unknown> = {}) =>
  DsrCreateBody.parse({
    type: 'deletion',
    receivedOn: sgToday(),
    requester: { name: 'Mei Tan', email: 'Mei@Example.com', phone: '9123 4567' },
    note: 'Asked by email, NRIC S1234567D on file',
    ...over,
  });
const create = (over: Record<string, unknown> = {}, tenantId = TENANT_A) =>
  dash(tenantId, (tx) => createRequest(tx, tenantId, userA, body(over)));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof DsrError) return e.code;
    throw e;
  }
};

describe('data-subject requests (FEAT-061 §5.1)', () => {
  it('is due 30 calendar days after it was received, with notes masked', async () => {
    const row = await create({ receivedOn: '2026-11-01' });
    expect(row.dueOn).toBe('2026-12-01');
    expect(row.status).toBe('open');
    expect(row.requesterEmail).toBe('mei@example.com');
    expect(row.note).not.toContain('S1234567D');
  });

  it('verifies, then completes an access request; stale versions and wrong states are 409', async () => {
    const row = await create({ type: 'access' });
    expect(
      await code(
        dash(TENANT_A, (tx) => completeRequest(tx, TENANT_A, userA, row.id, { version: 1 })),
      ),
    ).toBe('state_changed');
    const v = await dash(TENANT_A, (tx) =>
      verifyRequest(tx, TENANT_A, userA, row.id, {
        version: 1,
        method: 'email_reply',
        note: 'Replied from the address on file',
      }),
    );
    expect(v).toMatchObject({ status: 'verified', verifyMethod: 'email_reply', version: 2 });
    expect(
      await code(
        dash(TENANT_A, (tx) =>
          verifyRequest(tx, TENANT_A, userA, row.id, { version: 1, method: 'other', note: 'x' }),
        ),
      ),
    ).toBe('state_changed');
    const done = await dash(TENANT_A, (tx) =>
      completeRequest(tx, TENANT_A, userA, row.id, { version: 2, note: 'Sent the export' }),
    );
    expect(done.status).toBe('completed');
    expect(done.closedAt).not.toBeNull();
  });

  it('closes as unverified with a reason, and a deletion cannot be completed by hand', async () => {
    const row = await create();
    const u = await dash(TENANT_A, (tx) =>
      markUnverified(tx, TENANT_A, userA, row.id, { version: 1, reason: 'No reply' }),
    );
    expect(u).toMatchObject({ status: 'unverified', closeReason: 'No reply' });
    const del = await create();
    await dash(TENANT_A, (tx) =>
      verifyRequest(tx, TENANT_A, userA, del.id, { version: 1, method: 'in_person', note: 'ID' }),
    );
    expect(
      await code(
        dash(TENANT_A, (tx) => completeRequest(tx, TENANT_A, userA, del.id, { version: 2 })),
      ),
    ).toBe('wrong_type');
    const c = await dash(TENANT_A, (tx) =>
      closeRequest(tx, TENANT_A, userA, del.id, { version: 2, reason: 'Duplicate' }),
    );
    expect(c.status).toBe('closed');
  });

  it('edits only while open', async () => {
    const row = await create();
    const e = await dash(TENANT_A, (tx) =>
      updateRequest(tx, TENANT_A, userA, row.id, { version: 1, type: 'access' }),
    );
    expect(e).toMatchObject({ type: 'access', version: 2 });
    await dash(TENANT_A, (tx) =>
      markUnverified(tx, TENANT_A, userA, row.id, { version: 2, reason: 'x' }),
    );
    expect(
      await code(
        dash(TENANT_A, (tx) =>
          updateRequest(tx, TENANT_A, userA, row.id, { version: 3, type: 'deletion' }),
        ),
      ),
    ).toBe('state_changed');
  });

  it("tenant B can't see or change tenant A's request", async () => {
    const row = await create();
    expect(await code(dash(TENANT_B, (tx) => getRequest(tx, TENANT_B, row.id)))).toBe('not_found');
    expect(
      await code(
        dash(TENANT_B, (tx) =>
          markUnverified(tx, TENANT_B, userA, row.id, { version: 1, reason: 'x' }),
        ),
      ),
    ).toBe('not_found');
    const list = await dash(TENANT_B, (tx) => listRequests(tx, TENANT_B, { view: 'open' }));
    expect(list.items.map((i) => i.id)).not.toContain(row.id);
  });

  it('lists open requests by due date with counts, and closed ones apart', async () => {
    await owner.query(`delete from dsr_requests where tenant_id = $1`, [TENANT_B]);
    const today = sgToday();
    const late = await create({ receivedOn: addDays(today, -31) }, TENANT_B);
    const soon = await create({ receivedOn: addDays(today, -25) }, TENANT_B);
    const ok = await create({ receivedOn: today }, TENANT_B);
    const gone = await create({ receivedOn: today }, TENANT_B);
    await dash(TENANT_B, (tx) =>
      closeRequest(tx, TENANT_B, userA, gone.id, { version: 1, reason: 'dup' }),
    );
    const open = await dash(TENANT_B, (tx) => listRequests(tx, TENANT_B, { view: 'open' }));
    expect(open.items.map((i) => i.id)).toEqual([late.id, soon.id, ok.id]);
    expect(open.items.map((i) => i.dueState)).toEqual(['overdue', 'due_soon', 'ok']);
    expect(open.counts).toEqual({ open: 3, dueSoon: 1, overdue: 1 });
    expect(open.items[0]!.requesterLabel).toBe('M.T. · m•••@example.com');
    const closed = await dash(TENANT_B, (tx) => listRequests(tx, TENANT_B, { view: 'closed' }));
    expect(closed.items.map((i) => i.id)).toEqual([gone.id]);
  });

  it('audits every change with codes only, and the chain verifies', async () => {
    const row = await create();
    await dash(TENANT_A, (tx) =>
      verifyRequest(tx, TENANT_A, userA, row.id, {
        version: 1,
        method: 'phone_call',
        note: 'Called',
      }),
    );
    const events = await dash(TENANT_A, (tx) => requestEvents(tx, TENANT_A, row.id));
    expect(events.map((e) => e.code)).toEqual(['dsr.verified', 'dsr.opened']);
    const payloads = (
      await owner.query(
        `select payload::text as p, pii_ref from audit_entries where tenant_id = $1 and event_type like 'dsr.%'`,
        [TENANT_A],
      )
    ).rows;
    for (const p of payloads) {
      expect(p.p).not.toMatch(/mei|example|9123|Called/i);
      expect(p.pii_ref).toBeNull();
    }
    const detail = toDetail(
      await dash(TENANT_A, (tx) => getRequest(tx, TENANT_A, row.id)),
      events,
      (id) => (id === userA ? 'Owner' : null),
      { backupRetentionDays: 35 },
    );
    expect(detail.verification).toMatchObject({ method: 'phone_call', by: 'Owner' });
    expect(detail.events[0]).toMatchObject({ code: 'dsr.verified', by: 'Owner' });
    expect(detail.backupsClearBy).toBeNull();
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});
