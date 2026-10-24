/** Coverage topics marked "Doesn't apply" (KB-09; FEAT-019 §5.4, D8, AC-3, AC-8). */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  coverageSkippedTopics,
  coverageTemplate,
  setTopicSkipped,
  UnknownTopicError,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(`update business_profiles set industry = 'fnb' where tenant_id = $1`, [
    TENANT_A,
  ]);
  await owner.query(`update business_profiles set industry = 'retail' where tenant_id = $1`, [
    TENANT_B,
  ]);
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const skip = (tenantId: string, topicId: string, skipped: boolean) =>
  dash(tenantId, (tx) => setTopicSkipped(tx, { tenantId, userId: USER, topicId, skipped }));

describe('coverage topics', () => {
  it('give the F&B template, and none for an industry without one', async () => {
    const a = await dash(TENANT_A, (tx) => coverageTemplate(tx, TENANT_A));
    expect(a?.industry).toBe('fnb');
    expect(a?.template.suggestedFaqs.length).toBeGreaterThan(0);
    expect(await dash(TENANT_B, (tx) => coverageTemplate(tx, TENANT_B))).toBeNull();
  });

  it('skip and un-skip a topic once each, audited with the topic ID only', async () => {
    expect(await skip(TENANT_A, 'fnb.dine-in', true)).toEqual(['fnb.dine-in']);
    expect(await skip(TENANT_A, 'fnb.dine-in', true)).toEqual(['fnb.dine-in']);
    expect(await skip(TENANT_A, 'fnb.payment', true)).toEqual(['fnb.dine-in', 'fnb.payment']);
    expect(await skip(TENANT_A, 'fnb.dine-in', false)).toEqual(['fnb.payment']);
    expect(await dash(TENANT_A, (tx) => coverageSkippedTopics(tx, TENANT_A))).toEqual([
      'fnb.payment',
    ]);
    const { rows } = await owner.query(
      `select event_type, payload from audit_entries where tenant_id = $1 and event_type like 'coverage.%' order by seq`,
      [TENANT_A],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      'coverage.topic_skipped',
      'coverage.topic_skipped',
      'coverage.topic_skipped',
      'coverage.topic_unskipped',
    ]);
    expect(rows[0].payload).toEqual({ topic: 'fnb.dine-in' });
  });

  it("refuses a topic outside the tenant's template", async () => {
    await expect(skip(TENANT_A, 'fnb.nope', true)).rejects.toBeInstanceOf(UnknownTopicError);
    await expect(skip(TENANT_B, 'fnb.dine-in', true)).rejects.toBeInstanceOf(UnknownTopicError);
    expect(await dash(TENANT_B, (tx) => coverageSkippedTopics(tx, TENANT_B))).toEqual([]);
  });
});
