import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, verifyChain, type Anchor } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const N = 12;
const CONTACT = '00000000-0000-4000-8000-000000000042';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (let i = 1; i <= N; i++)
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      audit.append(tx, TENANT_A, {
        action: 'test.event',
        actorType: 'user',
        actorId: 'u1',
        subjectType: 'thing',
        subjectId: `t${i}`,
        payload: { n: i },
        ...(i === 4 ? { pii: { contactId: CONTACT, data: { name: 'Tan Ah Kow' } } } : {}),
      }),
    );
  await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
    audit.append(tx, TENANT_B, {
      action: 'test.event',
      actorType: 'system',
      subjectType: 'thing',
      subjectId: 'b1',
    }),
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const verifyA = (anchors?: Anchor[]) =>
  verifyChain(tdb.zone('dashboard'), TENANT_A, {
    anchors: anchors ? { list: async () => anchors } : undefined,
  });

/** Runs a tamper as the owner with the immutability trigger off, verifies, then restores. */
async function tampered(sqls: string[], anchors?: Anchor[]) {
  const snapshot = (
    await owner.query(`select * from audit_entries where tenant_id = $1`, [TENANT_A])
  ).rows;
  await owner.query(`alter table audit_entries disable trigger audit_entries_immutable`);
  await owner.query(`alter table audit_entries disable trigger audit_entries_link`);
  try {
    for (const q of sqls) await owner.query(q, [TENANT_A]);
    return await verifyA(anchors);
  } finally {
    await owner.query(`delete from audit_entries where tenant_id = $1`, [TENANT_A]);
    for (const r of snapshot)
      await owner.query(
        `insert into audit_entries select * from json_populate_record(null::audit_entries, $1)`,
        [JSON.stringify(r)],
      );
    await owner.query(`alter table audit_entries enable trigger audit_entries_link`);
    await owner.query(`alter table audit_entries enable trigger audit_entries_immutable`);
  }
}

const hashAt = async (seq: number) =>
  (
    await owner.query(`select hash from audit_entries where tenant_id = $1 and seq = $2`, [
      TENANT_A,
      seq,
    ])
  ).rows[0].hash as string;

describe('verifyChain on the database (AC-4, AC-6)', () => {
  it('reports an intact chain, with its PII commitment checked', async () => {
    expect(await verifyA([{ seq: 6, hash: await hashAt(6) }])).toEqual({
      tenantId: TENANT_A,
      ok: true,
      checked: N,
      headSeq: N,
      anchorsChecked: 1,
      piiChecked: 1,
    });
  });

  it.each([
    [
      'a changed payload value',
      [`update audit_entries set payload = '{"n":99}' where tenant_id = $1 and seq = 7`],
      7,
      'hash_mismatch',
    ],
    [
      'a changed actor',
      [`update audit_entries set actor_ref = 'u2' where tenant_id = $1 and seq = 5`],
      5,
      'hash_mismatch',
    ],
    [
      'a changed time',
      [`update audit_entries set ts = ts + interval '1 second' where tenant_id = $1 and seq = 3`],
      3,
      'hash_mismatch',
    ],
    [
      'a deleted middle entry',
      [`delete from audit_entries where tenant_id = $1 and seq = 6`],
      6,
      'seq_gap',
    ],
    [
      'a swapped pair',
      [
        `update audit_entries set seq = 1000 where tenant_id = $1 and seq = 8`,
        `update audit_entries set seq = 8 where tenant_id = $1 and seq = 9`,
        `update audit_entries set seq = 9 where tenant_id = $1 and seq = 1000`,
      ],
      8,
      'link_mismatch',
    ],
  ])('reports %s at the first tampered entry', async (_n, sqls, seq, reason) => {
    expect((await tampered(sqls)).broken).toEqual({ seq, reason });
  });

  it('reports a deleted tail entry through its anchor', async () => {
    const anchors = [{ seq: N, hash: await hashAt(N) }];
    const res = await tampered(
      [`delete from audit_entries where tenant_id = $1 and seq = ${N}`],
      anchors,
    );
    expect(res.broken).toEqual({ seq: N, reason: 'truncated' });
  });

  it('reports altered PII data, and verifies again after erasure', async () => {
    await owner.query(`update audit_pii set data = '{"name":"Lim"}' where contact_id = $1`, [
      CONTACT,
    ]);
    expect((await verifyA()).broken).toEqual({ seq: 4, reason: 'pii_commitment_mismatch' });
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      audit.erasePii(tx, TENANT_A, { contactId: CONTACT, actor: { type: 'user', id: 'u1' } }),
    );
    expect(await verifyA()).toMatchObject({ ok: true, checked: N + 1, piiChecked: 0 });
  });

  it("reads only the tenant's own chain", async () => {
    expect(await verifyChain(tdb.zone('dashboard'), TENANT_B)).toMatchObject({
      ok: true,
      checked: 1,
      headSeq: 1,
    });
  });
});
