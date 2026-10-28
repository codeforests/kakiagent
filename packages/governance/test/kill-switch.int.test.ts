/**
 * Kill switch (FEAT-057 §5.1; AC-1, AC-2): conditional pause/resume, one audit entry per
 * change, none for a repeat or a lost race, and a chain that still verifies.
 */
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aiPauseState, setAiPaused, verifyChain } from '../src/index.js';

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
  await owner.query(
    `update tenants set ai_paused = false, ai_paused_at = null, ai_paused_by = null`,
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const set = (paused: boolean) =>
  dash(TENANT_A, (tx) => setAiPaused(tx, { tenantId: TENANT_A, userId: userA, paused }));
const entries = async () =>
  (
    await owner.query(
      `select event_type, actor_type, actor_ref, subject_refs, payload::text as p
       from audit_entries where tenant_id = $1 and event_type like 'ai.%' order by seq`,
      [TENANT_A],
    )
  ).rows;
const row = async (tenantId = TENANT_A) =>
  (
    await owner.query(`select ai_paused, ai_paused_at, ai_paused_by from tenants where id = $1`, [
      tenantId,
    ])
  ).rows[0];

describe('kill switch (FEAT-057)', () => {
  it('pauses with who and when, audits IDs only, and a repeat changes nothing', async () => {
    const before = (await entries()).length;
    const paused = await set(true);
    expect(paused).toMatchObject({ changed: true, paused: true });
    expect(paused.pausedAt).toBeInstanceOf(Date);
    const r = await row();
    expect(r).toMatchObject({ ai_paused: true, ai_paused_by: userA });
    expect(r.ai_paused_at).toBeInstanceOf(Date);
    const added = (await entries()).slice(before);
    expect(added).toEqual([
      {
        event_type: 'ai.paused',
        actor_type: 'user',
        actor_ref: userA,
        subject_refs: [`tenant:${TENANT_A}`],
        p: '{}',
      },
    ]);
    const again = await set(true);
    expect(again).toMatchObject({ changed: false, paused: true });
    expect(again.pausedAt?.getTime()).toBe(paused.pausedAt?.getTime());
    expect(await entries()).toHaveLength(before + 1);
    // Tenant B is untouched.
    expect(await row(TENANT_B)).toEqual({
      ai_paused: false,
      ai_paused_at: null,
      ai_paused_by: null,
    });
    expect(await dash(TENANT_B, (tx) => aiPauseState(tx, TENANT_B))).toEqual({
      paused: false,
      pausedAt: null,
    });
  });

  it('two concurrent pauses leave one entry', async () => {
    const before = (await entries()).length;
    const results = await Promise.all([set(true), set(true)]);
    expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
    expect(results.every((r) => r.paused)).toBe(true);
    expect((await entries()).slice(before).map((e) => e.event_type)).toEqual(['ai.paused']);
  });

  it('resume clears the columns, audits once, and the chain verifies', async () => {
    await set(true);
    const before = (await entries()).length;
    expect(await set(false)).toEqual({ changed: true, paused: false, pausedAt: null });
    expect(await row()).toEqual({ ai_paused: false, ai_paused_at: null, ai_paused_by: null });
    expect(await set(false)).toEqual({ changed: false, paused: false, pausedAt: null });
    expect((await entries()).slice(before).map((e) => e.event_type)).toEqual(['ai.resumed']);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});
