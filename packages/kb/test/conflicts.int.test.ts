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
  ConflictChangedError,
  createFact,
  createWebsiteSource,
  dashboardKb,
  deleteFact,
  deleteSource,
  getSource,
  GstRequiredError,
  InvalidFactError,
  listConflicts,
  resolveConflict,
  reviewSummary,
  updateFact,
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

/** Tenant A: an approved manual S$26.00, then a website's S$28.50 read later (AC-1). */
async function crossSourceConflict(tenantId = TENANT_A) {
  const manualFact = await manual(tenantId, product(2600));
  // The owner's word dates from yesterday; the website is read now.
  await owner.query(`update facts set last_confirmed_at = now() - interval '1 day' where id = $1`, [
    manualFact.id,
  ]);
  const src = await stagedSource(tenantId, 'kakibakery.sg', [{ input: product(2850, 'unknown') }]);
  await owner.query(`update kb_sources set finished_at = now() where id = $1`, [src]);
  await promote(tenantId, src);
  const [conflict] = await inTx(tenantId, listConflicts);
  return { conflict: conflict!, manualId: manualFact.id, sourceId: src };
}

/** The entries after the last promote: the resolution's. */
async function resolutionAudit(tenantId: string) {
  const all = await auditOf(tenantId);
  const last = all.map((e) => e.event_type).lastIndexOf('kb_source.promoted');
  return all.slice(last + 1);
}

const refsOf = (c: { facts: { id: string; version: number }[] }) =>
  c.facts.map((m) => ({ id: m.id, version: m.version }));

describe('the conflicts list (UC-12 1; KB-17)', () => {
  it('groups by entity, each source with its passage and date, the strictly newer one suggested (AC-4)', async () => {
    const { conflict, manualId, sourceId } = await crossSourceConflict();
    await manual(TENANT_A, product(1500, 'inclusive', 'Butter cake'));
    const list = await inTx(TENANT_A, listConflicts);
    expect(list).toHaveLength(1);
    expect(conflict.id).toMatch(/^[0-9a-f]{16}$/);
    expect(conflict.type).toBe('product');
    const [web, typed] = conflict.facts;
    expect(web).toMatchObject({ sourceId, sourceName: 'kakibakery.sg', newer: true });
    expect(web!.passage!.quote).toBe('Pandan chiffon cake (20 cm) — S$28.50');
    expect(web!.passage!.before).toBe('Our cakes\n');
    expect(typed).toMatchObject({ id: manualId, sourceId: null, passage: null, newer: false });
    expect(web!.sourceDate.getTime()).toBeGreaterThan(typed!.sourceDate.getTime());
    expect(conflict.suggestedId).toBe(web!.id);
    expect(await inTx(TENANT_A, reviewSummary)).toMatchObject({ conflicted: 2, conflicts: 1 });
    expect(await inTx(TENANT_B, listConflicts)).toEqual([]);
  });

  it('suggests nothing when no source is strictly newer, as in one run (D4)', async () => {
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [
      { input: product(2850), confidence: 0.95 },
      { input: product(2600), confidence: 0.8 },
    ]);
    await promote(TENANT_A, src);
    const [conflict] = await inTx(TENANT_A, listConflicts);
    expect(conflict!.facts.map((m) => [m.value, m.newer])).toEqual([
      [expect.objectContaining({ priceCents: 2850 }), false],
      [expect.objectContaining({ priceCents: 2600 }), false],
    ]);
    expect(conflict!.suggestedId).toBeNull();
  });
});

describe('resolving (UC-12 2–3, 2a)', () => {
  it('use: keeps one value, rejects the rest, live at once, audited (AC-5)', async () => {
    const { conflict, manualId } = await crossSourceConflict();
    const webId = conflict.suggestedId!;
    await expect(
      inTx(TENANT_A, (ctx) => resolveConflict(ctx, refsOf(conflict), webId, 'use')),
    ).rejects.toBeInstanceOf(GstRequiredError);
    // Keeping the typed value needs no GST choice.
    const { fact, rejected } = await inTx(TENANT_A, (ctx) =>
      resolveConflict(ctx, refsOf(conflict), manualId, 'use'),
    );
    expect(fact).toMatchObject({ id: manualId, status: 'approved', version: 3 });
    expect(rejected).toEqual([{ id: webId, version: 2 }]);
    const facts = await factsOf(TENANT_A);
    expect(facts.map((f) => [f.id, f.status, f.chunk_version])).toEqual([
      [manualId, 'approved', 3],
      [webId, 'rejected', 2],
    ]);
    const v = await visible(TENANT_A);
    expect(v.view).toEqual([manualId]);
    expect(v.chunks).toEqual([manualId]);
    expect(v.search).toContain(manualId);
    const audit = await resolutionAudit(TENANT_A);
    expect(audit.map((e) => [e.event_type, e.payload.mode ?? null])).toEqual([
      ['fact.approved', 'conflict'],
      ['fact.rejected', 'conflict'],
      ['kb.conflict.resolved', null],
    ]);
    expect(audit.at(-1)).toMatchObject({
      actor_ref: USER,
      payload: { resolution: 'use', kept: manualId, facts: 2, type: 'product', suggested: false },
    });
    expect(audit[0]!.payload.batch).toBe(audit[1]!.payload.batch);
    expect(await inTx(TENANT_A, listConflicts)).toEqual([]);
  });

  it('use with a GST choice approves the price with that treatment (AC-5)', async () => {
    const { conflict } = await crossSourceConflict();
    const webId = conflict.suggestedId!;
    const current = conflict.facts[0]!;
    const next = { ...product(2850, 'inclusive') };
    expect(current.value).toEqual(next.value);
    const chunk = await prepareChunk(llm, TENANT_A, next);
    const { fact } = await inTx(TENANT_A, (ctx) =>
      resolveConflict(ctx, refsOf(conflict), webId, 'use', { next, chunk }),
    );
    expect(fact).toMatchObject({ status: 'approved', gstTreatment: 'inclusive' });
    const audit = await resolutionAudit(TENANT_A);
    expect(audit.map((e) => e.event_type)).toEqual([
      'fact.updated',
      'fact.approved',
      'fact.rejected',
      'kb.conflict.resolved',
    ]);
    expect(audit.at(-1)!.payload).toMatchObject({ suggested: true });
    expect((await visible(TENANT_A)).view).toEqual([webId]);
  });

  it('enter: stores and re-embeds the entered value on the kept fact (AC-6)', async () => {
    const { conflict, manualId } = await crossSourceConflict();
    const webId = conflict.suggestedId!;
    const next = product(2700, 'inclusive');
    const chunk = await prepareChunk(llm, TENANT_A, next);
    const { fact } = await inTx(TENANT_A, (ctx) =>
      resolveConflict(ctx, refsOf(conflict), webId, 'enter', { next, chunk }),
    );
    expect(fact).toMatchObject({ id: webId, status: 'approved', value: next.value });
    const { rows } = await owner.query(`select content from kb_chunks where fact_id = $1`, [webId]);
    expect(rows[0].content).toBe(chunk.content);
    expect((await factsOf(TENANT_A)).find((f) => f.id === manualId)!.status).toBe('rejected');
    expect((await auditOf(TENANT_A)).at(-1)!.payload).toMatchObject({ resolution: 'enter' });
  });

  it('disable: keeps one fact disabled, rejects the rest, none in answers; Knowledge re-enables it (AC-7)', async () => {
    const { conflict } = await crossSourceConflict();
    const webId = conflict.suggestedId!;
    const { fact } = await inTx(TENANT_A, (ctx) =>
      resolveConflict(ctx, refsOf(conflict), webId, 'disable'),
    );
    expect(fact.status).toBe('disabled');
    expect((await factsOf(TENANT_A)).map((f) => f.status)).toEqual(['rejected', 'disabled']);
    expect((await visible(TENANT_A)).view).toEqual([]);
    const audit = await resolutionAudit(TENANT_A);
    expect(audit.map((e) => e.event_type)).toEqual([
      'fact.disabled',
      'fact.rejected',
      'kb.conflict.resolved',
    ]);
    expect(audit.at(-1)!.payload).toMatchObject({ resolution: 'disable' });
    // GST unknown doesn't block disabling; enabling needs the treatment, as any edit.
    await owner.query(`update facts set gst_treatment = 'inclusive' where id = $1`, [webId]);
    const enabled = await inTx(TENANT_A, (ctx) =>
      updateFact(ctx, webId, { version: fact.version, status: 'approved' }),
    );
    expect(enabled.status).toBe('approved');
  });

  it('refuses a stale, partial or foreign request with the fresh conflict and writes nothing (AC-8, AC-9)', async () => {
    const { conflict, manualId } = await crossSourceConflict();
    const refs = refsOf(conflict);
    const before = await factsOf(TENANT_A);
    const attempt = (r: typeof refs, keep = manualId, tenant = TENANT_A) =>
      inTx(tenant, (ctx) => resolveConflict(ctx, r, keep, 'use')).then(
        () => null,
        (e: unknown) => e,
      );
    const stale = await attempt(refs.map((r) => ({ ...r, version: r.version + 1 })));
    expect(stale).toBeInstanceOf(ConflictChangedError);
    expect((stale as ConflictChangedError).conflict?.id).toBe(conflict.id);
    expect(await attempt(refs.filter((r) => r.id === manualId))).toBeInstanceOf(
      ConflictChangedError,
    );
    const foreign = await attempt(refs, manualId, TENANT_B);
    expect(foreign).toBeInstanceOf(ConflictChangedError);
    expect((foreign as ConflictChangedError).conflict).toBeNull();
    await expect(
      inTx(TENANT_A, (ctx) =>
        resolveConflict(ctx, refs, '00000000-0000-4000-8000-000000000999', 'use'),
      ),
    ).rejects.toBeInstanceOf(InvalidFactError);
    expect(await factsOf(TENANT_A)).toEqual(before);
    // A member that left the conflict: nothing is resolved.
    const third = await stagedSource(TENANT_A, 'kakicakes.sg', [{ input: product(3000) }]);
    await promote(TENANT_A, third);
    expect(await attempt(refs)).toBeInstanceOf(ConflictChangedError);
  });

  it('a rejected value is not proposed again; a third value reopens against the kept fact (AC-8)', async () => {
    const { conflict, manualId } = await crossSourceConflict();
    await inTx(TENANT_A, (ctx) => resolveConflict(ctx, refsOf(conflict), manualId, 'use'));
    const again = await stagedSource(TENANT_A, 'kakibakery.com.sg', [
      { input: product(2850, 'unknown') },
    ]);
    expect(await promote(TENANT_A, again)).toBe(0);
    const third = await stagedSource(TENANT_A, 'kakicakes.sg', [{ input: product(3000) }]);
    expect(await promote(TENANT_A, third)).toBe(1);
    const [reopened] = await inTx(TENANT_A, listConflicts);
    expect(reopened!.facts.map((m) => m.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceCents: 3000 }),
        expect.objectContaining({ priceCents: 2600 }),
      ]),
    );
    expect(reopened!.facts).toHaveLength(2);
  });
});

describe('settling after a delete (AC-10)', () => {
  it('deleting the source behind one side returns the other to its earlier status', async () => {
    const { manualId, sourceId } = await crossSourceConflict();
    await inTx(TENANT_A, async (ctx) => {
      const { source } = await getSource(ctx, sourceId);
      await owner.query(`update kb_sources set status = 'ready' where id = $1`, [sourceId]);
      return deleteSource(ctx, sourceId, source.version);
    });
    const facts = await factsOf(TENANT_A);
    expect(facts.map((f) => [f.id, f.status, f.versions])).toEqual([
      [manualId, 'approved', ['approved', 'conflicted', 'approved']],
    ]);
    expect((await visible(TENANT_A)).view).toEqual([manualId]);
    expect((await auditOf(TENANT_A)).at(-1)).toMatchObject({
      event_type: 'fact.conflict_cleared',
      payload: { version: 3, to: 'approved' },
    });
  });

  it('a fact written conflicted goes back to review; three disagreeing values stay open after one goes', async () => {
    const src = await stagedSource(TENANT_A, 'kakibakery.sg', [
      { input: product(2850) },
      { input: product(2600) },
      { input: product(3000) },
    ]);
    await promote(TENANT_A, src);
    const [c] = await inTx(TENANT_A, listConflicts);
    const [x, y, z] = c!.facts;
    await inTx(TENANT_A, (ctx) => deleteFact(ctx, x!.id, x!.version));
    const [still] = await inTx(TENANT_A, listConflicts);
    expect(still!.facts.map((m) => m.id).sort()).toEqual([y!.id, z!.id].sort());
    await inTx(TENANT_A, (ctx) => deleteFact(ctx, y!.id, y!.version));
    expect(await inTx(TENANT_A, listConflicts)).toEqual([]);
    expect((await factsOf(TENANT_A)).map((f) => [f.id, f.status])).toEqual([
      [z!.id, 'needs_review'],
    ]);
  });
});
