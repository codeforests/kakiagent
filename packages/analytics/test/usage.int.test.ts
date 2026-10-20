/**
 * The usage ledger and the cost governor against real Postgres (ADR-021, ADR-007
 * decision 3; FEAT-004 AC-4, AC-6).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import type { UsageEvent } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOVERNOR, runCostGovernor, usage, usageSink } from '../src/index.js';

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

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  tenantId: TENANT_A,
  conversationId: '00000000-0000-4000-8000-000000000001',
  turnId: '00000000-0000-4000-8000-000000000002',
  purpose: 'reply',
  model: 'reply.complex',
  provider: 'fake',
  providerModelId: 'fake-sonnet',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadInputTokens: 3500,
  cacheWriteInputTokens: 0,
  costUsd: 0.0061234567,
  ...over,
});

describe('usage ledger (AC-4)', () => {
  it('records an event under RLS with its IDs, counts and cost', async () => {
    await withTenant(tdb.zone('visitor'), TENANT_A, (tx) => usage.record(tx, event()));
    const rows = (
      await owner.query(
        `select tenant_id, conversation_id, turn_id, purpose, model, provider_model_id,
                input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
                cost_usd::text
         from usage_events where tenant_id = $1`,
        [TENANT_A],
      )
    ).rows;
    expect(rows).toEqual([
      {
        tenant_id: TENANT_A,
        conversation_id: '00000000-0000-4000-8000-000000000001',
        turn_id: '00000000-0000-4000-8000-000000000002',
        purpose: 'reply',
        model: 'reply.complex',
        provider_model_id: 'fake-sonnet',
        input_tokens: 1200,
        output_tokens: 300,
        cache_read_input_tokens: 3500,
        cache_write_input_tokens: 0,
        cost_usd: '0.0061234567',
      },
    ]);
  });

  it('logs a failed insert instead of throwing, and records the next event', async () => {
    const warnings: unknown[] = [];
    const sink = usageSink(tdb.zone('visitor'), { warn: (obj) => warnings.push(obj) });
    const before = Number(
      (await owner.query(`select count(*) from usage_events where tenant_id = $1`, [TENANT_B]))
        .rows[0].count,
    );
    // A tenant ID that isn't a UUID fails before any SQL runs; the sink still resolves.
    await expect(sink(event({ tenantId: 'not-a-uuid' }))).resolves.toBeUndefined();
    await sink(event({ tenantId: TENANT_B }));
    const after = Number(
      (await owner.query(`select count(*) from usage_events where tenant_id = $1`, [TENANT_B]))
        .rows[0].count,
    );
    expect(after).toBe(before + 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ tenantId: 'not-a-uuid', purpose: 'reply' });
  });
});

describe('cost governor (AC-6)', () => {
  /** n conversations of `sgdEach` each, `daysAgo` old, for a tenant (as the owner). */
  async function seed(tenantId: string, n: number, sgdEach: number, daysAgo = 1) {
    await owner.query(
      `insert into usage_events (tenant_id, conversation_id, purpose, model, provider, provider_model_id, cost_usd, created_at)
       select $1, gen_random_uuid(), 'reply', 'reply.simple', 'fake', 'fake-haiku', $2, now() - make_interval(days => $4)
       from generate_series(1, $3)`,
      [tenantId, sgdEach / DEFAULT_GOVERNOR.usdToSgd, n, daysAgo],
    );
  }
  const state = async (t: string) =>
    (
      await owner.query(
        `select cost_governor_step as step, cost_governor_changed_at as at from tenants where id = $1`,
        [t],
      )
    ).rows[0] as { step: number; at: Date | null };
  const setState = (t: string, step: number, daysAgo: number | null) =>
    owner.query(
      `update tenants set cost_governor_step = $2,
         cost_governor_changed_at = case when $3::int is null then null else now() - make_interval(days => $3::int) end
       where id = $1`,
      [t, step, daysAgo],
    );
  const governor = () => runCostGovernor(tdb.zone('outbox'));

  beforeEach(async () => {
    await owner.query(`delete from usage_events`);
    for (const t of [TENANT_A, TENANT_B]) await setState(t, 0, null);
  });

  it('raises a tenant above S$0.025 one step, and leaves a tenant within the band alone', async () => {
    await seed(TENANT_A, 25, 0.04);
    await seed(TENANT_B, 25, 0.022);
    const changes = await governor();
    expect(changes).toEqual([
      { tenantId: TENANT_A, oldStep: 0, newStep: 1, avgSgd: 0.04, conversations: 25 },
    ]);
    expect((await state(TENANT_A)).step).toBe(1);
    expect((await state(TENANT_B)).step).toBe(0);
  });

  it('raises at most once per 24 hours and never past step 3', async () => {
    await seed(TENANT_A, 25, 0.04);
    await governor();
    expect(await governor()).toEqual([]);
    await setState(TENANT_A, 2, 2);
    expect((await governor()).map((c) => c.newStep)).toEqual([3]);
    await setState(TENANT_A, 3, 2);
    expect(await governor()).toEqual([]);
    expect((await state(TENANT_A)).step).toBe(3);
  });

  it('lowers a step below S$0.020 only when the last change is more than 7 days old', async () => {
    await seed(TENANT_A, 25, 0.01);
    await setState(TENANT_A, 2, 3);
    expect(await governor()).toEqual([]);
    await setState(TENANT_A, 2, 8);
    expect(await governor()).toEqual([
      { tenantId: TENANT_A, oldStep: 2, newStep: 1, avgSgd: 0.01, conversations: 25 },
    ]);
  });

  it('ignores tenants with fewer than 20 conversations and rows older than 7 days', async () => {
    await seed(TENANT_A, 19, 0.5);
    await seed(TENANT_B, 30, 0.5, 8);
    expect(await governor()).toEqual([]);
  });

  it('averages per conversation, counting every call of a conversation', async () => {
    // 20 conversations with two calls each of S$0.015: S$0.03 per conversation.
    await seed(TENANT_A, 20, 0.015);
    await owner.query(
      `insert into usage_events (tenant_id, conversation_id, purpose, model, provider, provider_model_id, cost_usd)
       select tenant_id, conversation_id, 'triage', 'triage', 'fake', 'fake-haiku', cost_usd from usage_events`,
    );
    expect((await governor()).map((c) => c.avgSgd)).toEqual([0.03]);
  });
});
