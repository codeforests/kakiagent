/**
 * The stale-fact scan (KB-17, FEAT-018 §4; AC-5, AC-6): `kb_stale_scan()` run as the
 * outbox zone, the way scheduler-worker runs it.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '../src/testing.js';

let tdb: TestDatabase;
let owner: pg.Client;

async function scan() {
  const c = new pg.Client({ connectionString: tdb.urlFor('app_outbox') });
  await c.connect();
  try {
    return (await c.query(`select * from kb_stale_scan()`)).rows as {
      tenant_id: string;
      flagged: number;
      closed: number;
    }[];
  } finally {
    await c.end();
  }
}

async function fact(
  tenantId: string,
  opts: { type?: string; status?: string; monthsAgo: number; validUntil?: string },
) {
  const type = opts.type ?? 'faq';
  const value =
    type === 'promotion'
      ? { title: 'Promo', details: 'd' }
      : type === 'product'
        ? { name: 'Kaya toast', priceCents: 350, currency: 'SGD' }
        : { question: 'Do you deliver?', answer: 'Yes' };
  const { rows } = await owner.query(
    `insert into facts (tenant_id, type, status, value, gst_treatment, valid_until, last_confirmed_at)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(months => $7) - interval '1 day') returning id`,
    [
      tenantId,
      type,
      opts.status ?? 'approved',
      value,
      type === 'product' ? 'inclusive' : null,
      opts.validUntil ?? (type === 'promotion' ? new Date(Date.now() + 86_400_000) : null),
      opts.monthsAgo,
    ],
  );
  return rows[0].id as string;
}

const items = async (factId: string) =>
  (
    await owner.query(
      `select status, decided_by, proposed_by, proposed_change from corrections where source_type = 'stale' and fact_refs[1] = $1 order by created_at`,
      [factId],
    )
  ).rows;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

beforeEach(async () => {
  await owner.query(`delete from corrections`);
  await owner.query(`delete from kb_chunks`);
  await owner.query(`delete from fact_versions`);
  await owner.query(`delete from facts`);
  await owner.query(
    `update tenants set fact_review_months = '{"product":6,"faq":6,"policy":6,"promotion":6}'`,
  );
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('kb_stale_scan', () => {
  it('flags an overdue approved fact once, as an open reconfirm item, and keeps it visible', async () => {
    const id = await fact(TENANT_A, { type: 'product', monthsAgo: 7 });
    const fresh = await fact(TENANT_A, { monthsAgo: 5 });
    expect(await scan()).toEqual([{ tenant_id: TENANT_A, flagged: 1, closed: 0 }]);
    expect(await scan()).toEqual([]);
    const rows = await items(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open', proposed_by: 'system', decided_by: null });
    expect(rows[0].proposed_change).toMatchObject({
      kind: 'reconfirm',
      factId: id,
      factVersion: 1,
      factType: 'product',
      label: 'Kaya toast',
    });
    expect(new Date(rows[0].proposed_change.lastConfirmedAt).getTime()).toBeLessThan(Date.now());
    expect(await items(fresh)).toEqual([]);
    await owner.query('begin');
    await owner.query(`select set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const visible = await owner.query(
      `select count(*)::int as n from visitor_facts where id = $1`,
      [id],
    );
    await owner.query('rollback');
    expect(visible.rows[0].n).toBe(1);
  });

  it('skips needs_review, disabled and expired promotions', async () => {
    const ids = [
      await fact(TENANT_A, { status: 'needs_review', monthsAgo: 12 }),
      await fact(TENANT_A, { status: 'disabled', monthsAgo: 12 }),
      await fact(TENANT_A, {
        type: 'promotion',
        monthsAgo: 12,
        validUntil: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ];
    const live = await fact(TENANT_A, { type: 'promotion', monthsAgo: 12 });
    expect(await scan()).toEqual([{ tenant_id: TENANT_A, flagged: 1, closed: 0 }]);
    for (const id of ids) expect(await items(id)).toEqual([]);
    expect(await items(live)).toHaveLength(1);
  });

  it("honours each tenant's own months per type", async () => {
    await owner.query(
      `update tenants set fact_review_months = '{"product":6,"faq":2,"policy":6,"promotion":6}' where id = $1`,
      [TENANT_B],
    );
    const a = await fact(TENANT_A, { monthsAgo: 3 });
    const b = await fact(TENANT_B, { monthsAgo: 3 });
    expect(await scan()).toEqual([{ tenant_id: TENANT_B, flagged: 1, closed: 0 }]);
    expect(await items(a)).toEqual([]);
    expect(await items(b)).toHaveLength(1);
  });

  it('closes an item once the fact is re-confirmed, disabled or deleted, with no decider', async () => {
    const confirmed = await fact(TENANT_A, { monthsAgo: 7 });
    const disabled = await fact(TENANT_A, { monthsAgo: 7 });
    const deleted = await fact(TENANT_A, { monthsAgo: 7 });
    await scan();
    await owner.query(
      `update facts set version = version + 1, last_confirmed_at = now() where id = $1`,
      [confirmed],
    );
    await owner.query(`update facts set status = 'disabled' where id = $1`, [disabled]);
    await owner.query(`delete from facts where id = $1`, [deleted]);
    expect(await scan()).toEqual([{ tenant_id: TENANT_A, flagged: 0, closed: 3 }]);
    for (const id of [confirmed, disabled, deleted])
      expect(await items(id)).toEqual([
        expect.objectContaining({ status: 'dismissed', decided_by: null }),
      ]);
    expect(await scan()).toEqual([]);
  });

  it('replaces an item whose fact moved to a new version but is still overdue', async () => {
    const id = await fact(TENANT_A, { monthsAgo: 7 });
    await scan();
    await owner.query(`update facts set version = 2 where id = $1`, [id]);
    expect(await scan()).toEqual([{ tenant_id: TENANT_A, flagged: 1, closed: 1 }]);
    const rows = await items(id);
    expect(rows.map((r) => [r.status, r.proposed_change.factVersion])).toEqual([
      ['dismissed', 1],
      ['open', 2],
    ]);
  });
});
