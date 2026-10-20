import { GetObjectLockConfigurationCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorHeads,
  anchorKey,
  audit,
  createS3AnchorStore,
  verifyChain,
  type AnchorStore,
} from '../src/index.js';
import { startTestS3, type TestS3 } from './s3.js';

let tdb: TestDatabase;
let ts3: TestS3;
let owner: pg.Client;
let bucket: string;
let store: AnchorStore;

beforeAll(async () => {
  [tdb, ts3] = await Promise.all([startTestDatabase(), startTestS3()]);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  bucket = await ts3.lockedBucket();
  store = createS3AnchorStore({ bucket, region: ts3.region, endpoint: ts3.endpoint });
}, 120_000);
afterAll(async () => {
  await owner?.end();
  await Promise.all([tdb?.stop(), ts3?.stop()]);
});

const append = (tenantId: string, n: number) =>
  withTenant(tdb.zone('dashboard'), tenantId, async (tx) => {
    for (let i = 0; i < n; i++)
      await audit.append(tx, tenantId, {
        action: 'test.event',
        actorType: 'system',
        subjectType: 'thing',
        subjectId: `t${i}`,
        payload: { i },
      });
  });

const head = async (t: string) =>
  (await owner.query(`select seq::int, hash from audit_heads where tenant_id = $1`, [t])).rows[0];

describe('anchorHeads (AC-5, AC-11)', () => {
  it('anchors each moved head once, from the outbox zone', async () => {
    await append(TENANT_A, 3);
    await append(TENANT_B, 2);
    expect(await anchorHeads(tdb.zone('outbox'), store)).toEqual({ anchored: 2 });
    const a = await head(TENANT_A);
    expect(await store.list(TENANT_A)).toEqual([{ seq: 3, hash: a.hash }]);
    expect((await store.list(TENANT_B)).map((x) => x.seq)).toEqual([2]);

    expect(await anchorHeads(tdb.zone('outbox'), store)).toEqual({ anchored: 0 });

    await append(TENANT_A, 1);
    expect(await anchorHeads(tdb.zone('outbox'), store)).toEqual({ anchored: 1 });
    expect((await store.list(TENANT_A)).map((x) => x.seq)).toEqual([3, 4]);
  });

  it('locks every anchor object in compliance mode', async () => {
    const lock = await ts3.s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    expect(lock.ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
    const a = await head(TENANT_A);
    const obj = await ts3.s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: anchorKey(TENANT_A, a.seq, a.hash) }),
    );
    expect(obj.ObjectLockMode).toBe('COMPLIANCE');
    expect(obj.ObjectLockRetainUntilDate!.getTime()).toBeGreaterThan(Date.now());
  });

  it('a consistently rewritten chain fails at the anchored entry', async () => {
    expect(await verifyChain(tdb.zone('dashboard'), TENANT_A, { anchors: store })).toMatchObject({
      ok: true,
      checked: 4,
      anchorsChecked: 2,
    });
    // Rewrite tenant A's whole chain from scratch: every hash recomputed and linked.
    await owner.query(`alter table audit_entries disable trigger audit_entries_immutable`);
    await owner.query(`delete from audit_entries where tenant_id = $1`, [TENANT_A]);
    await owner.query(`alter table audit_entries enable trigger audit_entries_immutable`);
    await owner.query(
      `update audit_heads set seq = 0, hash = repeat('0', 64) where tenant_id = $1`,
      [TENANT_A],
    );
    await append(TENANT_A, 4);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A, { anchors: store })).broken).toEqual(
      { seq: 3, reason: 'anchor_mismatch' },
    );
  });
});
