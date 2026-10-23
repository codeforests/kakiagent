/**
 * Conflicts (FEAT-014, KB-06): detection when a source's facts are promoted, the
 * side-by-side list, resolution and settling, and what each does to the visitor view.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { fakeEmbed, gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entityKey } from '../src/conflicts.js';
import {
  createFact,
  createWebsiteSource,
  dashboardKb,
  getSource,
  parseWebsite,
  prepareChunk,
  promoteSource,
  searchVisitorFacts,
  visitorKb,
  type DashboardKbContext,
  type FactInput,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const llm = gatewayFromConfig({ provider: 'fake' });
const USER = 'user-owner-1';
const CONV = '00000000-0000-4000-8000-0000000000c1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
/** Audit entries outlive each test (the chain can't be cut); read only this test's. */
const marks = new Map<string, number>();
beforeEach(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    const { rows } = await owner.query(
      `select coalesce(max(seq), 0)::int as seq from audit_entries where tenant_id = $1`,
      [t],
    );
    marks.set(t, rows[0].seq);
  }
});
afterEach(async () => {
  for (const t of [
    'kb_chunks',
    'fact_versions',
    'facts',
    'kb_staged_facts',
    'kb_source_pages',
    'kb_sources',
  ])
    await owner.query(`delete from ${t}`);
});

const inTx = <T>(tenantId: string, fn: (ctx: DashboardKbContext) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => fn(dashboardKb(tx, tenantId, USER)));

const product = (
  cents: number,
  gst: 'inclusive' | 'exclusive' | 'unknown' = 'inclusive',
  name = 'Pandan chiffon cake',
): FactInput => ({
  type: 'product',
  value: { name, priceCents: cents, currency: 'SGD', unit: '20 cm' },
  gstTreatment: gst,
});
const line = (input: FactInput) =>
  input.type === 'product'
    ? `${input.value.name} (${input.value.unit}) — S$${(input.value.priceCents / 100).toFixed(2)}`
    : JSON.stringify(input.value);

/** A fact the owner entered: approved, with its chunk (FEAT-011). */
async function manual(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(llm, tenantId, input);
  return inTx(tenantId, (ctx) => createFact(ctx, input, chunk));
}

/**
 * A website source mid-run, as FEAT-012 leaves it before promote: processing, one page
 * per finding with the finding's line, and the findings staged.
 */
async function stagedSource(
  tenantId: string,
  domain: string,
  findings: { input: FactInput; confidence?: number }[],
) {
  const created = await inTx(tenantId, (ctx) =>
    createWebsiteSource(ctx, parseWebsite(`https://${domain}/`), { pageLimit: 100 }),
  );
  await owner.query(
    `update kb_sources set status = 'processing', stage = 'promote', attempt = 1 where id = $1`,
    [created.id],
  );
  for (const [i, f] of findings.entries()) {
    const content = `Our cakes\n${line(f.input)}\nBaked daily.`;
    const quote = line(f.input);
    const start = content.indexOf(quote);
    const { rows } = await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
       values ($1, $2, 1, $3, $4, 'included', $5) returning id`,
      [tenantId, created.id, i, `https://${domain}/p${i}`, content],
    );
    await owner.query(
      `insert into kb_staged_facts (tenant_id, source_id, attempt, page_id, type, value, gst_treatment,
         quote, quote_start, quote_end, confidence, dedupe_key)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        created.id,
        rows[0].id,
        f.input.type,
        JSON.stringify(f.input.value),
        f.input.gstTreatment,
        quote,
        start,
        start + quote.length,
        f.confidence ?? 0.9,
        entityKey(f.input),
      ],
    );
  }
  return created.id;
}

async function promote(tenantId: string, sourceId: string) {
  const { source } = await inTx(tenantId, (ctx) => getSource(ctx, sourceId));
  return promoteSource(tdb.zone('ingest'), source, llm);
}

async function factsOf(tenantId: string) {
  return (
    await owner.query<{
      id: string;
      status: string;
      version: number;
      cents: number;
      source_id: string | null;
      chunk_version: number;
      versions: string[];
    }>(
      `select f.id, f.status, f.version, (f.value->>'priceCents')::int as cents, f.source_id,
              (select c.fact_version from kb_chunks c where c.fact_id = f.id) as chunk_version,
              (select array_agg(v.status order by v.version) from fact_versions v where v.fact_id = f.id) as versions
       from facts f where f.tenant_id = $1 order by f.created_at, f.id`,
      [tenantId],
    )
  ).rows;
}

async function auditOf(tenantId: string) {
  return (
    await owner.query(
      `select event_type, actor_type, actor_ref, subject_refs, payload from audit_entries
       where tenant_id = $1 and seq > $2 order by seq`,
      [tenantId, marks.get(tenantId)],
    )
  ).rows;
}

async function visible(tenantId: string) {
  const viewIds = (
    await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
      tx.execute<{ id: string }>(`select id from visitor_facts` as never),
    )
  ).rows.map((r) => r.id);
  const chunkIds = (
    await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
      tx.execute<{ fact_id: string }>(`select fact_id from visitor_chunks` as never),
    )
  ).rows.map((r) => r.fact_id);
  const hits = await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), fakeEmbed('pandan chiffon cake price'), {
      k: 50,
      maxDistance: 2,
    }),
  );
  return { view: viewIds, chunks: chunkIds, search: hits.map((h) => h.id) };
}

describe('detection at promote (KB-06; FEAT-014 §5.2)', () => {
  it('flags an approved and a needs_review fact a new source disagrees with, out of answers at once (AC-1)', async () => {
    const approved = await manual(TENANT_A, product(2600));
    expect((await visible(TENANT_A)).view).toContain(approved.id);
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [{ input: product(2850) }]);
    expect(await promote(TENANT_A, src)).toBe(1);

    const facts = await factsOf(TENANT_A);
    expect(facts.map((f) => [f.cents, f.status, f.version, f.chunk_version, f.versions])).toEqual([
      [2600, 'conflicted', 2, 2, ['approved', 'conflicted']],
      [2850, 'conflicted', 1, 1, ['conflicted']],
    ]);
    const v = await visible(TENANT_A);
    for (const f of facts) {
      expect(v.view).not.toContain(f.id);
      expect(v.chunks).not.toContain(f.id);
      expect(v.search).not.toContain(f.id);
    }
    const audit = await auditOf(TENANT_A);
    expect(audit.slice(-2)).toEqual([
      {
        event_type: 'fact.conflicted',
        actor_type: 'system',
        actor_ref: 'ingest-worker',
        subject_refs: [`fact:${approved.id}`],
        payload: { version: 2, from: 'approved', source: src },
      },
      {
        event_type: 'kb_source.promoted',
        actor_type: 'system',
        actor_ref: 'ingest-worker',
        subject_refs: [`kb_source:${src}`],
        payload: { facts: 1, attempt: 1, conflicted: 1 },
      },
    ]);
  });

  it('flags a needs_review fact from another source the same way, and joins an open conflict without flagging again', async () => {
    const first = await stagedSource(TENANT_A, 'kakibakery.sg', [{ input: product(2600) }]);
    await promote(TENANT_A, first);
    const second = await stagedSource(TENANT_A, 'kakibakery.com.sg', [{ input: product(2850) }]);
    await promote(TENANT_A, second);
    expect((await factsOf(TENANT_A)).map((f) => [f.cents, f.status, f.versions])).toEqual([
      [2600, 'conflicted', ['needs_review', 'conflicted']],
      [2850, 'conflicted', ['conflicted']],
    ]);
    expect(
      (await auditOf(TENANT_A)).find((e) => e.event_type === 'fact.conflicted')?.payload,
    ).toMatchObject({
      from: 'needs_review',
    });
    const third = await stagedSource(TENANT_A, 'kakicakes.sg', [{ input: product(3000) }]);
    await promote(TENANT_A, third);
    const facts = await factsOf(TENANT_A);
    expect(facts.map((f) => [f.cents, f.status, f.version])).toEqual([
      [2600, 'conflicted', 2],
      [2850, 'conflicted', 1],
      [3000, 'conflicted', 1],
    ]);
  });

  it('writes both of two prices one run finds for one product, conflicted; one price twice is one fact (AC-2)', async () => {
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [
      { input: product(2850), confidence: 0.95 },
      { input: product(2600), confidence: 0.8 },
      { input: product(1500, 'inclusive', 'Butter cake') },
      { input: product(1500, 'unknown', 'Butter cake'), confidence: 0.7 },
    ]);
    expect(await promote(TENANT_A, src)).toBe(3);
    expect((await factsOf(TENANT_A)).map((f) => [f.cents, f.status])).toEqual(
      expect.arrayContaining([
        [2850, 'conflicted'],
        [2600, 'conflicted'],
        [1500, 'needs_review'],
      ]),
    );
    expect((await source(src)).facts_count).toBe(3);
  });

  it.each(['approved', 'needs_review', 'rejected', 'disabled'] as const)(
    'writes nothing for a finding that agrees with a %s fact (AC-3)',
    async (status) => {
      const f = await manual(TENANT_A, product(2600, 'inclusive'));
      await owner.query(`update facts set status = $2 where id = $1`, [f.id, status]);
      const src = await stagedSource(TENANT_A, 'kakibakery.sg', [
        { input: product(2600, 'unknown') },
      ]);
      expect(await promote(TENANT_A, src)).toBe(0);
      expect((await factsOf(TENANT_A)).map((r) => r.status)).toEqual([status]);
    },
  );

  it('treats inclusive against exclusive at one price as a conflict, and leaves other entities and tenants alone (AC-3)', async () => {
    await manual(TENANT_A, product(2600, 'inclusive'));
    await manual(TENANT_A, product(2600, 'inclusive', 'Butter cake'));
    await manual(TENANT_B, product(9999));
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [
      { input: product(2600, 'exclusive') },
      { input: { ...product(2850), value: { ...product(2850).value, unit: '1 kg' } } as FactInput },
    ]);
    await promote(TENANT_A, src);
    const facts = await factsOf(TENANT_A);
    expect(facts.map((f) => f.status)).toEqual([
      'conflicted',
      'approved',
      'conflicted',
      'needs_review',
    ]);
    expect((await factsOf(TENANT_B)).map((f) => f.status)).toEqual(['approved']);
  });

  it('never joins rejected or disabled facts to a conflict (D3)', async () => {
    const r = await manual(TENANT_A, product(2600));
    const d = await manual(TENANT_A, product(2700));
    await owner.query(`update facts set status = 'rejected' where id = $1`, [r.id]);
    await owner.query(`update facts set status = 'disabled' where id = $1`, [d.id]);
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [{ input: product(2850) }]);
    await promote(TENANT_A, src);
    expect((await factsOf(TENANT_A)).map((f) => f.status)).toEqual([
      'rejected',
      'disabled',
      'needs_review',
    ]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a raw row, snake_case
async function source(id: string): Promise<any> {
  const { rows } = await owner.query(`select * from kb_sources where id = $1`, [id]);
  return rows[0];
}
