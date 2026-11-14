import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  lastVerification,
  VerifyCooldown,
  verifyForDashboard,
  verifyLockKey,
  VerifyRunning,
  type Anchor,
  type AnchorSource,
} from '../src/index.js';
import { seedChain } from './seed-chain.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
let clock = Date.now();
/** Each run is a minute after the last, so the cooldown only bites where a test wants it. */
const tick = () => {
  clock += 60_000;
  const at = new Date(clock);
  return () => at;
};
const errors: object[] = [];
const log = { error: (o: object) => void errors.push(o) };

const head = async () =>
  (
    await owner.query<{ seq: string; hash: string }>(
      `select seq, hash from audit_heads where tenant_id = $1`,
      [TENANT_A],
    )
  ).rows[0]!;
const anchorsAtHead = async (): Promise<AnchorSource> => {
  const h = await head();
  return { list: async () => [{ seq: Number(h.seq), hash: h.hash }] };
};
const fixed = (anchors: Anchor[]): AnchorSource => ({ list: async () => anchors });
const run = (anchors: AnchorSource, now = tick()) =>
  verifyForDashboard(tdb.zone('dashboard'), TENANT_A, { anchors, userId: USER, now, log });
const verifiedCount = async () =>
  Number(
    (
      await owner.query(
        `select count(*) as n from audit_entries where tenant_id = $1 and event_type = 'audit.verified'`,
        [TENANT_A],
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await seedChain(
    owner,
    TENANT_A,
    Array.from({ length: 20 }, (_, i) => ({ eventType: 'fact.updated', payload: { n: i } })),
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('verifyForDashboard (FEAT-060 AC-3)', () => {
  it('an intact chain with anchors is ok and checks to the head; one audit.verified, PII-free', async () => {
    const before = await verifiedCount();
    const h = Number((await head()).seq);
    const r = await run(await anchorsAtHead());
    expect(r).toMatchObject({ ok: true, anchors: 'checked', anchorsChecked: 1, broken: null });
    expect(r.checked).toBe(h);
    expect(r.headSeq).toBe(h);
    expect(await verifiedCount()).toBe(before + 1);
    const entry = (
      await owner.query(
        `select seq, actor_type, actor_ref, subject_refs, payload, pii_ref from audit_entries
         where tenant_id = $1 and event_type = 'audit.verified' order by seq desc limit 1`,
        [TENANT_A],
      )
    ).rows[0];
    expect(Number(entry.seq)).toBe(h + 1);
    expect(entry).toMatchObject({
      actor_type: 'user',
      actor_ref: USER,
      subject_refs: [`tenant:${TENANT_A}`],
      pii_ref: null,
      payload: { ok: true, checked: h, head_seq: h, anchors: 'checked', anchors_checked: 1 },
    });
    const last = await lastVerification(tdb.zone('dashboard'), TENANT_A);
    expect(last).toMatchObject({ ok: true, headSeq: h, byUserId: USER });
  });

  it('a tampered payload breaks the chain at that entry with hash_mismatch', async () => {
    const snapshot = (
      await owner.query(`select * from audit_entries where tenant_id = $1 and seq = 3`, [TENANT_A])
    ).rows[0];
    await owner.query(`alter table audit_entries disable trigger audit_entries_immutable`);
    try {
      await owner.query(
        `update audit_entries set payload = '{"n": 99}' where tenant_id = $1 and seq = 3`,
        [TENANT_A],
      );
      const r = await run(await anchorsAtHead());
      expect(r.ok).toBe(false);
      expect(r.broken).toEqual({ seq: 3, reason: 'hash_mismatch' });
      expect(errors.some((e) => (e as { seq?: number }).seq === 3)).toBe(true);
      const last = await lastVerification(tdb.zone('dashboard'), TENANT_A);
      expect(last?.ok).toBe(false);
    } finally {
      await owner.query(`update audit_entries set payload = $2 where tenant_id = $1 and seq = 3`, [
        TENANT_A,
        JSON.stringify(snapshot.payload),
      ]);
      await owner.query(`alter table audit_entries enable trigger audit_entries_immutable`);
    }
    expect((await run(await anchorsAtHead())).ok).toBe(true);
  });

  it('an anchor beyond the head reports truncated', async () => {
    const h = await head();
    const r = await run(fixed([{ seq: Number(h.seq) + 5, hash: 'f'.repeat(64) }]));
    expect(r.ok).toBe(false);
    expect(r.broken?.reason).toBe('truncated');
  });

  it('anchors unavailable → the database result, anchors unavailable; none yet → none_yet', async () => {
    const down: AnchorSource = {
      list: async () => {
        throw new Error('S3 down');
      },
    };
    expect(await run(down)).toMatchObject({ ok: true, anchors: 'unavailable', anchorsChecked: 0 });
    expect(await run(fixed([]))).toMatchObject({ ok: true, anchors: 'none_yet' });
  });

  it('a second run within 30 s is refused with the seconds left', async () => {
    await run(fixed([]));
    // The cooldown runs from the entry's own time (the database clock).
    const last = await lastVerification(tdb.zone('dashboard'), TENANT_A);
    const before = await verifiedCount();
    const second = run(fixed([]), () => new Date(Date.parse(last!.verifiedAt) + 10_000));
    await expect(second).rejects.toBeInstanceOf(VerifyCooldown);
    await expect(second).rejects.toMatchObject({ retryAfterS: 20 });
    expect(await verifiedCount()).toBe(before);
  });

  it('a run while another holds the tenant lock is refused as running', async () => {
    await owner.query('select pg_advisory_lock(hashtextextended($1, 0))', [
      verifyLockKey(TENANT_A),
    ]);
    try {
      await expect(run(fixed([]))).rejects.toBeInstanceOf(VerifyRunning);
    } finally {
      await owner.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
        verifyLockKey(TENANT_A),
      ]);
    }
    expect((await run(fixed([]))).ok).toBe(true);
  });

  it('runs under the dashboard zone and the lock is released after each run', async () => {
    const held = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*) as n from pg_locks where locktype = 'advisory' and granted`,
      ),
    );
    expect(Number(held.rows[0]!.n)).toBe(0);
  });
});
