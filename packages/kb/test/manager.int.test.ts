/**
 * The KB manager (FEAT-011): paged and filtered lists, deletion, policy and promotion
 * facts with their validity, and GST-unknown prices (KB-05 p, KB-07, KB-15 p).
 */
import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFact,
  dashboardKb,
  deleteFact,
  FactNotFoundError,
  getFact,
  InvalidCursorError,
  InvalidFactError,
  listFacts,
  mergePatch,
  prepareChunk,
  searchVisitorFacts,
  sgDateOf,
  sgDayAfter,
  sgDayStart,
  updateFact,
  VersionConflictError,
  visitorKb,
  type FactFilter,
  type FactInput,
  type FactPatch,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const llm = gatewayFromConfig({ provider: 'fake' });
const USER = 'user-owner-1';
const CONV = '00000000-0000-4000-8000-0000000000c1';

const today = sgDateOf(new Date());
const shift = (days: number) =>
  sgDateOf(new Date(sgDayStart(today).getTime() + days * 86_400_000 + 3600_000));

const REFUND: FactInput = {
  type: 'policy',
  value: {
    kind: 'refund',
    title: 'Refunds on whole cakes',
    details: 'Cancel at least two days before collection for a full refund.',
  },
  gstTreatment: null,
};
const BUNDLE: FactInput = {
  type: 'promotion',
  value: {
    title: 'Deepavali kueh bundle',
    details: 'Any two boxes of kueh with a free ondeh ondeh box.',
    priceCents: 2000,
    currency: 'SGD',
  },
  gstTreatment: 'exclusive',
  validity: { validFrom: null, validUntil: sgDayAfter(shift(10)) },
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = (tenantId: string) => (tx: Parameters<typeof dashboardKb>[0]) =>
  dashboardKb(tx, tenantId, USER);

async function create(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(llm, tenantId, input);
  return withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    createFact(dash(tenantId)(tx), input, chunk),
  );
}

async function edit(tenantId: string, id: string, patch: FactPatch) {
  const zone = tdb.zone('dashboard');
  const current = await withTenant(zone, tenantId, (tx) => getFact(dash(tenantId)(tx), id));
  const chunk = await prepareChunk(llm, tenantId, mergePatch(current, patch));
  return withTenant(zone, tenantId, (tx) => updateFact(dash(tenantId)(tx), id, patch, chunk));
}

const remove = (tenantId: string, id: string, version: number) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => deleteFact(dash(tenantId)(tx), id, version));

const list = (tenantId: string, filter: FactFilter) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => listFacts(dash(tenantId)(tx), filter));

async function search(tenantId: string, query: string) {
  const { vectors } = await llm.embed({ texts: [query], purpose: 'query', meta: { tenantId } });
  return withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), vectors[0]!),
  );
}

describe('policies and promotions (KB-05 p; AC-4, AC-5)', () => {
  it('creates both by hand as approved, with validity in the version row', async () => {
    const policy = await create(TENANT_A, REFUND);
    const promo = await create(TENANT_A, BUNDLE);
    expect(policy).toMatchObject({ type: 'policy', status: 'approved', version: 1 });
    expect(promo.validity.validUntil?.toISOString()).toBe(sgDayAfter(shift(10)).toISOString());
    const v = await owner.query(
      `select valid_from, valid_until from fact_versions where fact_id = $1`,
      [promo.id],
    );
    expect(v.rows).toEqual([{ valid_from: null, valid_until: sgDayAfter(shift(10)) }]);
    const chunk = await owner.query(`select content from kb_chunks where fact_id = $1`, [
      policy.id,
    ]);
    expect(chunk.rows[0].content).toBe(
      `${REFUND.value.title}\n${(REFUND.value as { details: string }).details}`,
    );
  });

  it.each<[string, FactInput]>([
    ['a policy with GST', { ...REFUND, gstTreatment: 'inclusive' } as unknown as FactInput],
    [
      'a policy with validity',
      { ...REFUND, validity: { validFrom: null, validUntil: sgDayAfter(today) } },
    ],
    ['a promotion without an end', { ...BUNDLE, validity: { validFrom: null, validUntil: null } }],
    [
      'a start after the end',
      {
        ...BUNDLE,
        validity: { validFrom: sgDayStart(shift(5)), validUntil: sgDayAfter(shift(3)) },
      },
    ],
    ['a promotion price without GST', { ...BUNDLE, gstTreatment: null }],
    [
      'GST without a promotion price',
      { ...BUNDLE, value: { title: 'Free candle', details: 'With every cake.' } },
    ],
  ])('refuses %s', async (_name, input) => {
    await expect(create(TENANT_A, input)).rejects.toBeInstanceOf(InvalidFactError);
  });

  it("a promotion's GST follows its price; validity is for promotions only", async () => {
    const promo = await create(TENANT_A, BUNDLE);
    const unpriced = await edit(TENANT_A, promo.id, {
      version: 1,
      value: { title: 'Deepavali kueh bundle', details: 'Free ondeh ondeh box with two boxes.' },
    });
    expect(unpriced.gstTreatment).toBeNull();
    await expect(
      edit(TENANT_A, promo.id, {
        version: 2,
        value: { title: 'Bundle', details: 'Two boxes.', priceCents: 1800, currency: 'SGD' },
      }),
    ).rejects.toBeInstanceOf(InvalidFactError);
    const later = await edit(TENANT_A, promo.id, {
      version: 2,
      validity: { validFrom: sgDayStart(shift(1)) },
    });
    expect(later.validity.validFrom?.toISOString()).toBe(sgDayStart(shift(1)).toISOString());
    expect(later.validity.validUntil?.toISOString()).toBe(sgDayAfter(shift(10)).toISOString());
    const policy = await create(TENANT_A, REFUND);
    await expect(
      edit(TENANT_A, policy.id, { version: 1, validity: { validUntil: sgDayAfter(today) } }),
    ).rejects.toBeInstanceOf(InvalidFactError);
  });

  it('applies validity in Singapore days: today is in, yesterday ended, tomorrow not yet', async () => {
    const endsToday = await create(TENANT_A, {
      ...BUNDLE,
      validity: { validFrom: null, validUntil: sgDayAfter(today) },
    });
    const endedYesterday = await create(TENANT_A, {
      ...BUNDLE,
      validity: { validFrom: null, validUntil: sgDayAfter(shift(-1)) },
    });
    const startsTomorrow = await create(TENANT_A, {
      ...BUNDLE,
      validity: { validFrom: sgDayStart(shift(1)), validUntil: sgDayAfter(shift(3)) },
    });
    const ids = await withTenant(tdb.zone('visitor'), TENANT_A, async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from visitor_facts`)).rows.map((r) => r.id),
    );
    expect(ids).toContain(endsToday.id);
    expect(ids).not.toContain(endedYesterday.id);
    expect(ids).not.toContain(startsTomorrow.id);
  });

  it('visitor search returns a promotion with its end instant', async () => {
    const promo = await create(TENANT_A, {
      ...BUNDLE,
      value: { ...BUNDLE.value, title: 'Mooncake lantern set' },
    } as FactInput);
    const hit = (await search(TENANT_A, 'mooncake lantern set')).find((r) => r.id === promo.id);
    expect(hit?.type).toBe('promotion');
    expect(hit?.type === 'promotion' && hit.validUntil?.toISOString()).toBe(
      sgDayAfter(shift(10)).toISOString(),
    );
  });
});

describe('list: filters and keyset paging (KB-07; AC-1)', () => {
  it('filters by type, status, GST and text across every type', async () => {
    await create(TENANT_B, REFUND);
    await create(TENANT_B, BUNDLE);
    const [policies, promos, byDetails, byTitle] = await Promise.all([
      list(TENANT_B, { type: 'policy' }),
      list(TENANT_B, { type: 'promotion', status: 'approved' }),
      list(TENANT_B, { q: 'ONDEH' }),
      list(TENANT_B, { q: 'refunds on whole' }),
    ]);
    expect(policies.facts.every((f) => f.type === 'policy')).toBe(true);
    expect(policies.facts.length).toBeGreaterThan(0);
    expect(promos.facts.every((f) => f.type === 'promotion' && f.status === 'approved')).toBe(true);
    expect(byDetails.facts.map((f) => f.type)).toEqual(['promotion']);
    expect(byTitle.facts.map((f) => f.type)).toEqual(['policy']);
    await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment) values ($1, 'product', 'approved', $2, 'unknown')`,
      [TENANT_B, { name: 'Ondeh ondeh box', priceCents: 1800, currency: 'SGD' }],
    );
    const gst = await list(TENANT_B, { gst: 'unknown' });
    expect(gst.facts.map((f) => f.gstTreatment)).toEqual(['unknown']);
  });

  it('pages through every row exactly once, even within one millisecond', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        (
          await create(TENANT_A, {
            ...REFUND,
            value: { kind: 'other', title: `Pager rule ${i}`, details: 'x' },
          })
        ).id,
      );
    // Same millisecond, different microseconds: a JS Date cursor would skip rows.
    for (const [i, id] of ids.entries())
      await owner.query(
        `update facts set updated_at = '2026-10-20 10:00:00.123000+00'::timestamptz + make_interval(secs => $1 / 1000000.0) where id = $2`,
        [i % 3, id],
      );
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(TENANT_A, { q: 'Pager rule', limit: 3, cursor });
      seen.push(...page.facts.map((f) => f.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('refuses a malformed cursor', async () => {
    for (const cursor of ['nonsense', Buffer.from('2026-10-20|x').toString('base64url')])
      await expect(list(TENANT_A, { cursor })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe('delete (KB-07; D1; AC-2, AC-3)', () => {
  it('removes the fact, chunk and versions, audits it, and the next search cannot find it', async () => {
    const fact = await create(TENANT_A, {
      ...REFUND,
      value: { kind: 'delivery', title: 'Durian delivery rules', details: 'Sealed boxes only.' },
    });
    await edit(TENANT_A, fact.id, {
      version: 1,
      value: { kind: 'delivery', title: 'Durian delivery rules', details: 'Sealed boxes.' },
    });
    expect((await search(TENANT_A, 'durian delivery rules')).map((r) => r.id)).toContain(fact.id);
    await expect(remove(TENANT_A, fact.id, 1)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await owner.query(`select 1 from facts where id = $1`, [fact.id])).rowCount).toBe(1);

    await remove(TENANT_A, fact.id, 2);
    for (const [table, col] of [
      ['facts', 'id'],
      ['fact_versions', 'fact_id'],
      ['kb_chunks', 'fact_id'],
    ])
      expect(
        (await owner.query(`select 1 from ${table} where ${col} = $1`, [fact.id])).rowCount,
      ).toBe(0);
    expect((await search(TENANT_A, 'durian delivery rules')).map((r) => r.id)).not.toContain(
      fact.id,
    );
    const audit = await owner.query(
      `select event_type, actor_ref, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [fact.id],
    );
    expect(audit.rows.at(-1)).toEqual({
      event_type: 'fact.deleted',
      actor_ref: USER,
      payload: { type: 'policy', version: 2 },
    });
    await expect(remove(TENANT_A, fact.id, 2)).rejects.toBeInstanceOf(FactNotFoundError);
  });

  it("can't delete another tenant's fact", async () => {
    const fact = await create(TENANT_A, REFUND);
    await expect(remove(TENANT_B, fact.id, 1)).rejects.toBeInstanceOf(FactNotFoundError);
    expect((await owner.query(`select 1 from facts where id = $1`, [fact.id])).rowCount).toBe(1);
  });

  it('deletes a fact in any status', async () => {
    const fact = await create(TENANT_A, REFUND);
    await owner.query(`update facts set status = 'rejected' where id = $1`, [fact.id]);
    await remove(TENANT_A, fact.id, 1);
    expect((await owner.query(`select 1 from facts where id = $1`, [fact.id])).rowCount).toBe(0);
  });
});

describe('GST-unknown prices (KB-15 p; AC-7)', () => {
  it('stay hidden through unrelated edits and appear once the treatment is chosen', async () => {
    const { rows } = await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment, source)
       values ($1, 'product', 'needs_review', $2, 'unknown', 'website') returning id`,
      [TENANT_A, { name: 'Kueh lapis tray', priceCents: 3200, currency: 'SGD' }],
    );
    const id = rows[0].id as string;
    await owner.query(
      `insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment)
       select tenant_id, id, version, status, value, gst_treatment from facts where id = $1`,
      [id],
    );
    const renamed = await edit(TENANT_A, id, {
      version: 1,
      value: { name: 'Kueh lapis tray, large', priceCents: 3200, currency: 'SGD' },
    });
    expect(renamed).toMatchObject({ status: 'approved', gstTreatment: 'unknown' });
    expect((await search(TENANT_A, 'kueh lapis tray large')).map((r) => r.id)).not.toContain(id);
    await edit(TENANT_A, id, { version: 2, gstTreatment: 'inclusive' });
    expect((await search(TENANT_A, 'kueh lapis tray large')).map((r) => r.id)).toContain(id);
  });
});
