/**
 * Erase (FEAT-061 §5.4; AC-6): after a deletion every `find+erase` store holds zero rows for the
 * seeded subject, tenant B's identical subject is untouched, the audit chain verifies, the S3 job
 * lists the attachment, and the request is completed with counts and a masked requester.
 */
import { DsrCreateBody, sgToday } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRequest,
  DsrError,
  eraseSubject,
  findSubject,
  storesWith,
  verifyChain,
  verifyRequest,
  type DsrRow,
} from '../src/index.js';
import { rowsLeft, seedSubject, SUBJECT, type Seeded } from './dsr-seed.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;
let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const id = async (email: string) =>
    (await owner.query(`select id from users where email = $1`, [email])).rows[0].id as string;
  userA = await id('owner@kaki-bakery.test');
  a = await seedSubject(owner, TENANT_A);
  b = await seedSubject(owner, TENANT_B);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof DsrError) return e.code;
    throw e;
  }
};
async function request(type: 'access' | 'deletion', verify = true): Promise<DsrRow> {
  const row = await dash((tx) =>
    createRequest(
      tx,
      TENANT_A,
      userA,
      DsrCreateBody.parse({
        type,
        receivedOn: sgToday(),
        requester: { name: 'Mei Tan', email: SUBJECT.email, phone: SUBJECT.phone },
      }),
    ),
  );
  if (!verify) return row;
  return dash((tx) =>
    verifyRequest(tx, TENANT_A, userA, row.id, { version: 1, method: 'email_reply', note: 'ok' }),
  );
}

describe('eraseSubject (AC-6)', () => {
  it('refuses an unverified or non-deletion request and IDs outside the find result', async () => {
    const sel = { contactIds: [a.contact], conversationIds: [], factIds: [], stagedFactIds: [] };
    const open = await request('deletion', false);
    expect(await code(dash((tx) => eraseSubject(tx, TENANT_A, userA, open.id, 1, sel)))).toBe(
      'state_changed',
    );
    const access = await request('access');
    expect(
      await code(dash((tx) => eraseSubject(tx, TENANT_A, userA, access.id, access.version, sel))),
    ).toBe('wrong_type');
    const del = await request('deletion');
    expect(
      await code(
        dash((tx) =>
          eraseSubject(tx, TENANT_A, userA, del.id, del.version, {
            ...sel,
            conversationIds: [a.otherConv],
          }),
        ),
      ),
    ).toBe('not_in_result');
    expect(
      await code(
        dash((tx) =>
          eraseSubject(tx, TENANT_A, userA, del.id, del.version, { ...sel, contactIds: [] }),
        ),
      ),
    ).toBe('nothing_selected');
  });

  it('removes the subject from every store in one transaction and the chain still verifies', async () => {
    const before = await rowsLeft(owner, TENANT_A, a);
    for (const [store, n] of Object.entries(before)) expect(n, store).toBeGreaterThan(0);
    const bBefore = await rowsLeft(owner, TENANT_B, b);

    const req = await request('deletion');
    const out = await dash((tx) =>
      eraseSubject(tx, TENANT_A, userA, req.id, req.version, {
        contactIds: [a.contact],
        conversationIds: [a.mentionConv],
        factIds: [a.fact],
        stagedFactIds: [a.staged],
      }),
    );

    const after = await rowsLeft(owner, TENANT_A, a);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    // Every find+erase store the registry names is covered by the zero-rows check.
    const checked = new Set(Object.keys(after));
    expect(storesWith('find+erase').filter((t) => !checked.has(t))).toEqual([]);
    expect(await rowsLeft(owner, TENANT_B, b)).toEqual(bBefore);
    // Someone else's conversation and contact stay.
    const other = await owner.query(`select 1 from conversations where id = $1`, [a.otherConv]);
    expect(other.rowCount).toBe(1);

    expect(out.counts).toMatchObject({
      contacts: 2,
      conversations: 4,
      messages: 5,
      email_attachments: 1,
      leads: 1,
      consents: 1,
      audit_pii: 1,
      facts: 1,
      kb_staged_facts: 1,
      corrections: 1,
      visitor_events: 1,
    });
    expect(out.objectKeys).toEqual([a.attachmentKey]);
    expect(out.request).toMatchObject({
      status: 'completed',
      requesterName: 'M.T.',
      requesterEmail: 'm•••@example.com',
      requesterPhone: '+65 ••••4567',
      objectsPending: 1,
    });
    expect(out.request.requesterErasedAt).not.toBeNull();
    expect(out.request.outcome).toEqual({ counts: out.counts, auditSeq: out.auditSeq });

    const job = (
      await owner.query(
        `select topic, group_key, payload from outbox where tenant_id = $1 and payload->>'kind' = 'dsr_objects'`,
        [TENANT_A],
      )
    ).rows;
    expect(job).toEqual([
      {
        topic: 'conversation-turns',
        group_key: `dsr:${req.id}`,
        payload: {
          kind: 'dsr_objects',
          tenantId: TENANT_A,
          requestId: req.id,
          keys: [a.attachmentKey],
        },
      },
    ]);

    const audit = (
      await owner.query(
        `select event_type, payload::text as p from audit_entries where tenant_id = $1 and event_type in ('dsr.erased', 'audit.pii_erased') order by seq`,
        [TENANT_A],
      )
    ).rows;
    expect(audit.map((e) => e.event_type)).toEqual([
      'audit.pii_erased',
      'audit.pii_erased',
      'dsr.erased',
    ]);
    expect(audit.at(-1)!.p).not.toMatch(/mei|example|9123/i);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_B)).ok).toBe(true);

    // Found again: nothing left.
    const again = await dash((tx) =>
      findSubject(tx, TENANT_A, { email: SUBJECT.email, phone: SUBJECT.phone }),
    );
    expect(again.result.contacts).toEqual([]);
    expect(again.result.conversations).toEqual([]);
    expect(again.result.kb).toEqual([]);
  });
});
