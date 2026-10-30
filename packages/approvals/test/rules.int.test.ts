/**
 * Boundary rules (FEAT-054 §5.1; AC-1, AC-4, AC-9): safe defaults, immutable versions,
 * the stale check, and one code-only audit entry per save with a chain that verifies.
 */
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { verifyChain } from '@kaki/governance';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  rulesInForce,
  rulesSaved,
  RulesStale,
  SAFE_DEFAULTS,
  saveRules,
  type BoundaryRules,
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
afterEach(async () => {
  await owner.query(`delete from boundary_rules`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const save = (expectedVersion: number | null, rules: BoundaryRules = SAFE_DEFAULTS) =>
  dash((tx) => saveRules(tx, TENANT_A, { expectedVersion, rules, userId: userA }));
const entries = async () =>
  (
    await owner.query(
      `select actor_type, actor_ref, payload::text as p from audit_entries
       where tenant_id = $1 and event_type = 'rules.updated' order by seq`,
      [TENANT_A],
    )
  ).rows;

describe('boundary rules', () => {
  it('runs on the safe defaults until the first save (AC-1, AC-9)', async () => {
    const inForce = await dash((tx) => rulesInForce(tx, TENANT_A));
    expect(inForce).toEqual({ rules: SAFE_DEFAULTS, version: null });
    expect(await dash((tx) => rulesSaved(tx, TENANT_A))).toBe(false);
    // The visitor zone reads the same.
    const visitor = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      rulesInForce(tx, TENANT_A),
    );
    expect(visitor.version).toBeNull();
  });

  it('saves numbered versions, normalised, and the newest is in force (AC-2, AC-9)', async () => {
    const before = (await entries()).length;
    const v1 = await save(null, {
      ...SAFE_DEFAULTS,
      blockedTopics: [' Competitor  prices', 'competitor prices', 'Politics'],
      maxDiscountPct: 10,
    });
    expect(v1.version).toBe(1);
    expect(v1.rules.blockedTopics).toEqual(['Competitor prices', 'Politics']);
    const v2 = await save(1, {
      ...v1.rules,
      forbiddenCommitments: ['legal_advice', 'medical_advice'],
    });
    expect(v2.version).toBe(2);
    const inForce = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      rulesInForce(tx, TENANT_A),
    );
    expect(inForce.version).toBe(2);
    expect(inForce.rules.forbiddenCommitments).toEqual(['legal_advice', 'medical_advice']);
    expect(await dash((tx) => rulesSaved(tx, TENANT_A))).toBe(true);

    const all = (await entries()).slice(before);
    expect(all).toHaveLength(2);
    expect(all[0].actor_type).toBe('user');
    expect(all[0].actor_ref).toBe(userA);
    expect(JSON.parse(all[0].p)).toEqual({
      version: 1,
      changed: ['blocked_topics', 'max_discount'],
    });
    expect(JSON.parse(all[1].p)).toEqual({ version: 2, changed: ['forbidden_commitments'] });
    // No topic text in the chain (ADR-014).
    expect(all.map((e) => e.p).join()).not.toMatch(/Competitor|Politics/);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });

  it('refuses a stale version and writes nothing (AC-4)', async () => {
    await save(null);
    const before = (await entries()).length;
    await expect(save(null)).rejects.toBeInstanceOf(RulesStale);
    await expect(save(5)).rejects.toBeInstanceOf(RulesStale);
    expect((await entries()).length).toBe(before);
  });

  it('lets one of two concurrent saves from the same version win', async () => {
    await save(null);
    const results = await Promise.allSettled([save(1), save(1)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(RulesStale);
    const n = await owner.query(`select count(*)::int as n from boundary_rules`);
    expect(n.rows[0].n).toBe(2);
  });
});
