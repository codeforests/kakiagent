/**
 * Fact review (FEAT-013): single and bulk decisions, Approve all against its preview,
 * undo, the queue with its passages, and what each does to the visitor view (KB-16).
 */
import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { verifyChain } from '@kaki/governance';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAll,
  approveFact,
  approveSelected,
  createFact,
  dashboardKb,
  FactNotFoundError,
  getFact,
  GstRequiredError,
  InvalidCursorError,
  InvalidStateError,
  listReviewFacts,
  mergePatch,
  prepareChunk,
  previewApproveAll,
  PreviewStaleError,
  rejectFact,
  rejectSelected,
  reviewSummary,
  searchVisitorFacts,
  undoReview,
  updateFact,
  VersionConflictError,
  visitorKb,
  type DashboardKbContext,
  type FactInput,
  type FactPatch,
  type FactRef,
  type ReviewScope,
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
  await owner.query(`delete from kb_chunks`);
  await owner.query(`delete from fact_versions`);
  await owner.query(`delete from facts`);
  await owner.query(`delete from kb_source_pages`);
  await owner.query(`delete from kb_sources`);
});

const inTx = <T>(tenantId: string, fn: (ctx: DashboardKbContext) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => fn(dashboardKb(tx, tenantId, USER)));

const product = (name: string, cents: number, gst: 'inclusive' | 'unknown' = 'inclusive') =>
  ({
    type: 'product',
    value: { name, priceCents: cents, currency: 'SGD' },
    gstTreatment: gst,
  }) as FactInput;
const faq = (question: string, answer: string): FactInput => ({
  type: 'faq',
  value: { question, answer },
  gstTreatment: null,
});
const policy = (title: string, details: string): FactInput => ({
  type: 'policy',
  value: { kind: 'refund', title, details },
  gstTreatment: null,
});

async function seedSource(tenantId: string, domain: string, pages: Record<string, string>) {
  const { rows } = await owner.query(
    `insert into kb_sources (tenant_id, kind, status, url, domain, page_limit, attested_by,
                             attested_at, created_by, finished_at)
     values ($1, 'website', 'ready', $2, $3, 100, $4, now(), $4, now()) returning id`,
    [tenantId, `https://${domain}/`, domain, USER],
  );
  const id = rows[0].id as string;
  let seq = 0;
  for (const [url, content] of Object.entries(pages))
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
       values ($1, $2, 1, $3, $4, 'included', $5)`,
      [tenantId, id, seq++, url, content],
    );
  return id;
}

/** A fact as FEAT-012's promote leaves it: `needs_review`, with provenance, chunk at v1. */
async function seedFact(
  tenantId: string,
  input: FactInput,
  from?: { sourceId: string; url: string; content: string; quote: string; confidence?: number },
): Promise<FactRef> {
  const chunk = await prepareChunk(llm, tenantId, input);
  const fact = await inTx(tenantId, (ctx) => createFact(ctx, input, chunk));
  const start = from ? from.content.indexOf(from.quote) : 0;
  await owner.query(
    `update facts set status = 'needs_review', source = $2, source_id = $3, confidence = $4,
       provenance = $5 where id = $1`,
    [
      fact.id,
      from ? 'website' : 'manual',
      from?.sourceId ?? null,
      from ? (from.confidence ?? 0.9) : null,
      from
        ? JSON.stringify({
            url: from.url,
            title: null,
            quote: from.quote,
            start,
            end: start + from.quote.length,
          })
        : null,
    ],
  );
  await owner.query(`update fact_versions set status = 'needs_review' where fact_id = $1`, [
    fact.id,
  ]);
  return { id: fact.id, version: 1 };
}

/** The facts a visitor turn can retrieve: `visitor_chunks` joins `visitor_facts` by version. */
async function visible(tenantId: string): Promise<string[]> {
  const { rows } = await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    tx.execute<{ id: string }>(sql`select fact_id as id from visitor_chunks`),
  );
  return rows.map((r) => r.id).sort();
}

async function search(tenantId: string, query: string) {
  const { vectors } = await llm.embed({ texts: [query], purpose: 'query', meta: { tenantId } });
  return withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), vectors[0]!),
  );
}

async function auditOf(id: string) {
  const { rows } = await owner.query(
    `select event_type, actor_type, actor_ref, payload from audit_entries
     where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
    [id],
  );
  return rows;
}

async function auditByType(tenantId: string, eventType: string) {
  const { rows } = await owner.query(
    `select subject_refs, payload, actor_ref from audit_entries
     where tenant_id = $1 and event_type = $2 and seq > $3 order by seq`,
    [tenantId, eventType, marks.get(tenantId) ?? 0],
  );
  return rows;
}

const row = async (id: string) =>
  (
    await owner.query(
      `select f.status, f.version, f.gst_treatment, f.last_confirmed_at, f.updated_at,
              c.fact_version as chunk_version
       from facts f left join kb_chunks c on c.fact_id = f.id where f.id = $1`,
      [id],
    )
  ).rows[0];

describe('single decisions (KB-16; AC-1, AC-3)', () => {
  it('approve: approved, version + 1, version row, chunk moved, confirmed, audited, visible', async () => {
    const ref = await seedFact(TENANT_A, product('Chocolate fudge cake', 5500));
    expect(await visible(TENANT_A)).toEqual([]);
    expect(await search(TENANT_A, 'Chocolate fudge cake')).toEqual([]);
    await owner.query(`update facts set last_confirmed_at = now() - interval '1 day'`);

    const fact = await inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 1));
    expect(fact).toMatchObject({ status: 'approved', version: 2 });
    const r = await row(ref.id);
    expect(r).toMatchObject({ status: 'approved', version: 2, chunk_version: 2 });
    expect(Date.now() - new Date(r.last_confirmed_at).getTime()).toBeLessThan(60_000);
    const versions = await owner.query(
      `select version, status, changed_by from fact_versions where fact_id = $1 order by version`,
      [ref.id],
    );
    expect(versions.rows.at(-1)).toEqual({ version: 2, status: 'approved', changed_by: USER });
    expect((await auditOf(ref.id)).at(-1)).toEqual({
      event_type: 'fact.approved',
      actor_type: 'user',
      actor_ref: USER,
      payload: { version: 2, mode: 'single' },
    });
    expect(await visible(TENANT_A)).toEqual([ref.id]);
    const hits = await search(TENANT_A, 'Chocolate fudge cake');
    expect(hits.map((h) => h.id)).toContain(ref.id);
  });

  it('edit and approve: new content, re-embedded chunk, fact.updated then fact.approved', async () => {
    const ref = await seedFact(TENANT_A, product('Pandan chiffon', 2800, 'unknown'));
    const current = await inTx(TENANT_A, (ctx) => getFact(ctx, ref.id));
    const patch: FactPatch = {
      version: 1,
      value: { name: 'Pandan chiffon cake', priceCents: 3000, currency: 'SGD' },
      gstTreatment: 'inclusive',
    };
    const next = mergePatch(current, patch);
    const chunk = await prepareChunk(llm, TENANT_A, next);
    const fact = await inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 1, { next, chunk }));
    expect(fact).toMatchObject({
      status: 'approved',
      version: 2,
      gstTreatment: 'inclusive',
      value: { name: 'Pandan chiffon cake', priceCents: 3000 },
    });
    const c = await owner.query(`select content, fact_version from kb_chunks where fact_id = $1`, [
      ref.id,
    ]);
    expect(c.rows[0]).toMatchObject({ fact_version: 2, content: chunk.content });
    expect((await auditOf(ref.id)).slice(-2).map((a) => [a.event_type, a.payload])).toEqual([
      ['fact.updated', { version: 2 }],
      ['fact.approved', { version: 2, mode: 'edited' }],
    ]);
    expect(await visible(TENANT_A)).toEqual([ref.id]);
  });

  it('a GST-unknown price needs the GST choice (KB-15)', async () => {
    const ref = await seedFact(TENANT_A, product('Cupcake box', 3600, 'unknown'));
    await expect(inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 1))).rejects.toBeInstanceOf(
      GstRequiredError,
    );
    expect(await row(ref.id)).toMatchObject({ status: 'needs_review', version: 1 });
    const current = await inTx(TENANT_A, (ctx) => getFact(ctx, ref.id));
    const next = mergePatch(current, { version: 1, gstTreatment: 'exclusive' });
    const chunk = await prepareChunk(llm, TENANT_A, next);
    const fact = await inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 1, { next, chunk }));
    expect(fact).toMatchObject({ status: 'approved', gstTreatment: 'exclusive' });
  });

  it('reject: rejected, audited, never visible', async () => {
    const ref = await seedFact(TENANT_A, faq('Do you deliver?', 'Yes, islandwide.'));
    const fact = await inTx(TENANT_A, (ctx) => rejectFact(ctx, ref.id, 1));
    expect(fact).toMatchObject({ status: 'rejected', version: 2 });
    expect(await row(ref.id)).toMatchObject({ chunk_version: 2 });
    expect((await auditOf(ref.id)).at(-1)).toMatchObject({
      event_type: 'fact.rejected',
      actor_ref: USER,
      payload: { version: 2, mode: 'single' },
    });
    expect(await visible(TENANT_A)).toEqual([]);
    expect(await search(TENANT_A, 'Do you deliver?')).toEqual([]);
  });

  it('refuses a stale version, a decided fact, a conflicted fact and another tenant', async () => {
    const ref = await seedFact(TENANT_A, faq('Halal?', 'Our kitchen is Muslim-owned.'));
    await expect(inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 2))).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    await expect(inTx(TENANT_B, (ctx) => approveFact(ctx, ref.id, 1))).rejects.toBeInstanceOf(
      FactNotFoundError,
    );
    await inTx(TENANT_A, (ctx) => rejectFact(ctx, ref.id, 1));
    await expect(inTx(TENANT_A, (ctx) => approveFact(ctx, ref.id, 2))).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    const other = await seedFact(TENANT_A, faq('Parking?', 'Street parking outside.'));
    await owner.query(`update facts set status = 'conflicted' where id = $1`, [other.id]);
    await expect(inTx(TENANT_A, (ctx) => rejectFact(ctx, other.id, 1))).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(await row(other.id)).toMatchObject({ status: 'conflicted', version: 1 });
  });

  it('an approving edit through updateFact is audited as an approval (AC-7)', async () => {
    const ref = await seedFact(TENANT_A, faq('Eggless?', 'On request.'));
    const current = await inTx(TENANT_A, (ctx) => getFact(ctx, ref.id));
    const patch: FactPatch = {
      version: 1,
      value: { question: 'Eggless?', answer: 'Yes, 3 days ahead.' },
    };
    const chunk = await prepareChunk(llm, TENANT_A, mergePatch(current, patch));
    await inTx(TENANT_A, (ctx) => updateFact(ctx, ref.id, patch, chunk));
    expect((await auditOf(ref.id)).slice(-2).map((a) => [a.event_type, a.payload])).toEqual([
      ['fact.updated', { version: 2 }],
      ['fact.approved', { version: 2, mode: 'edited' }],
    ]);
  });
});

describe('the queue (KB-16; AC-2)', () => {
  const page =
    'Welcome to Kaki Bakery, the home of kueh and cakes in Tiong Bahru since 1988. ' +
    'Our signature Chocolate fudge cake (1 kg) — S$55.00, eggless option available on request. ' +
    'Order three days ahead for collection or delivery. '.repeat(6);

  it('lists needs_review and conflicted facts, prices, policies, promotions, FAQs, then crawl order', async () => {
    const src = await seedSource(TENANT_A, 'kakibakery.sg', { 'https://kakibakery.sg/': page });
    const q1 = await seedFact(TENANT_A, faq('Q1?', 'A1.'));
    const p1 = await seedFact(TENANT_A, product('Chocolate fudge cake', 5500), {
      sourceId: src,
      url: 'https://kakibakery.sg/',
      content: page,
      quote: 'Chocolate fudge cake (1 kg) — S$55.00',
      confidence: 0.64,
    });
    const pol = await seedFact(TENANT_A, policy('Refunds', 'Two days notice.'));
    const p2 = await seedFact(TENANT_A, product('Kueh lapis', 1800));
    const done = await seedFact(TENANT_A, product('Old', 100));
    await inTx(TENANT_A, (ctx) => approveFact(ctx, done.id, 1));
    const other = await seedFact(TENANT_B, product('Not yours', 100));

    const all = await inTx(TENANT_A, (ctx) => listReviewFacts(ctx));
    expect(all.facts.map((f) => f.id)).toEqual([p1.id, p2.id, pol.id, q1.id]);
    expect(all.facts.map((f) => f.id)).not.toContain(other.id);
    const first = all.facts[0]!;
    expect(first).toMatchObject({ confidence: 0.64, sourceName: 'kakibakery.sg' });
    expect(first.sourceCapturedAt).toBeInstanceOf(Date);
    const pv = first.passage!;
    expect(pv.quote).toBe('Chocolate fudge cake (1 kg) — S$55.00');
    expect(page.slice(first.provenance!.start, first.provenance!.end)).toBe(pv.quote);
    expect(page.slice(0, first.provenance!.start).endsWith(pv.before)).toBe(true);
    expect(pv.before.length).toBeLessThanOrEqual(160);
    expect(pv.after.endsWith('…')).toBe(true);
    expect(pv.after.length).toBeLessThanOrEqual(161);
    expect(page.includes(pv.after.slice(0, -1))).toBe(true);
    expect(all.facts[1]!.passage).toBeNull();

    // Scope by type and by source.
    const prices = await inTx(TENANT_A, (ctx) => listReviewFacts(ctx, { type: 'product' }));
    expect(prices.facts.map((f) => f.id)).toEqual([p1.id, p2.id]);
    const fromSite = await inTx(TENANT_A, (ctx) => listReviewFacts(ctx, { sourceId: src }));
    expect(fromSite.facts.map((f) => f.id)).toEqual([p1.id]);

    // Conflicted facts stay listed (FEAT-014 resolves them).
    await owner.query(`update facts set status = 'conflicted' where id = $1`, [q1.id]);
    expect((await inTx(TENANT_A, (ctx) => listReviewFacts(ctx))).facts.at(-1)?.status).toBe(
      'conflicted',
    );
  });

  it('pages with a cursor, every fact once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await seedFact(TENANT_A, faq(`Q${i}?`, 'A.'))).id);
    ids.push((await seedFact(TENANT_A, product('P', 100))).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const p = await inTx(TENANT_A, (ctx) => listReviewFacts(ctx, {}, cursor, 3));
      seen.push(...p.facts.map((f) => f.id));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(seen[0]).toBe(ids.at(-1));
    await expect(
      inTx(TENANT_A, (ctx) => listReviewFacts(ctx, {}, 'bm90LWEtY3Vyc29y')),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('summarises counts for the tab, the filters and the empty state', async () => {
    const src = await seedSource(TENANT_A, 'kakibakery.sg', {});
    await owner.query(
      `insert into kb_sources (tenant_id, kind, status, stage, url, domain, page_limit,
                               attested_by, attested_at, created_by)
       values ($1, 'website', 'processing', 'crawl', 'https://b.sg/', 'b.sg', 100, $2, now(), $2)`,
      [TENANT_A, USER],
    );
    await seedFact(TENANT_A, product('A', 100), {
      sourceId: src,
      url: 'https://kakibakery.sg/',
      content: 'A S$1.00',
      quote: 'A S$1.00',
    });
    await seedFact(TENANT_A, faq('Q?', 'A.'));
    const c = await seedFact(TENANT_A, faq('C?', 'A.'));
    await owner.query(`update facts set status = 'conflicted' where id = $1`, [c.id]);
    const d = await seedFact(TENANT_A, faq('D?', 'A.'));
    await inTx(TENANT_A, (ctx) => approveFact(ctx, d.id, 1));
    const s = await inTx(TENANT_A, (ctx) => reviewSummary(ctx));
    expect(s).toEqual({
      needsReview: 2,
      conflicted: 1,
      byType: { product: 1, policy: 0, promotion: 0, faq: 2 },
      bySource: [
        { id: src, name: 'kakibakery.sg', count: 1 },
        { id: null, name: null, count: 2 },
      ],
      approvedInUse: 1,
      sourcesBusy: 1,
    });
  });
});

describe('Approve all (KB-16; UC-15 3a; AC-5)', () => {
  async function seedMix(tenantId = TENANT_A) {
    const src = await seedSource(tenantId, 'kakibakery.sg', {});
    const site = { sourceId: src, url: 'https://kakibakery.sg/', content: 'x', quote: 'x' };
    return {
      src,
      prices: [
        await seedFact(tenantId, product('A', 100), site),
        await seedFact(tenantId, product('B', 200)),
      ],
      unknown: await seedFact(tenantId, product('C', 300, 'unknown'), site),
      policy: await seedFact(tenantId, policy('Refunds', 'Two days.'), site),
      faqs: [
        await seedFact(tenantId, faq('Q1?', 'A.')),
        await seedFact(tenantId, faq('Q2?', 'A.')),
      ],
      conflicted: await (async () => {
        const r = await seedFact(tenantId, faq('Q3?', 'A.'), site);
        await owner.query(`update facts set status = 'conflicted' where id = $1`, [r.id]);
        return r;
      })(),
    };
  }

  it('previews counts by type, excluding GST-unknown and conflicted facts, then approves exactly that', async () => {
    const m = await seedMix();
    const preview = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx));
    expect(preview).toMatchObject({
      count: 5,
      byType: { product: 2, policy: 1, promotion: 0, faq: 2 },
      excluded: { gstUnknown: 1, conflicted: 1 },
    });
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);

    const { facts } = await inTx(TENANT_A, (ctx) => approveAll(ctx, {}, preview.previewHash));
    const expected = [...m.prices, m.policy, ...m.faqs].map((r) => r.id).sort();
    expect(facts.map((r) => r.id).sort()).toEqual(expected);
    expect(facts.every((r) => r.version === 2)).toBe(true);
    expect(await visible(TENANT_A)).toEqual(expected);
    expect(await row(m.unknown.id)).toMatchObject({ status: 'needs_review' });
    expect(await row(m.conflicted.id)).toMatchObject({ status: 'conflicted' });

    for (const r of facts)
      expect((await auditOf(r.id)).at(-1)).toMatchObject({
        event_type: 'fact.approved',
        actor_ref: USER,
        payload: { version: 2, mode: 'all' },
      });
    const [summary] = await auditByType(TENANT_A, 'kb.review.approved_all');
    expect(summary.actor_ref).toBe(USER);
    expect(summary.payload).toEqual({
      count: 5,
      product: 2,
      policy: 1,
      promotion: 0,
      faq: 2,
      scope: 'all',
      previewHash: preview.previewHash,
    });
    const batch = (await auditOf(m.policy.id)).at(-1)!.payload.batch;
    expect(summary.subject_refs[0]).toBe(`kb_review:${batch}`);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });

  it('approves nothing when the set changed since the preview', async () => {
    const m = await seedMix();
    const changes: [string, () => Promise<unknown>][] = [
      ['a fact added', () => seedFact(TENANT_A, faq('New?', 'A.'))],
      [
        'a fact edited',
        () => owner.query(`update facts set version = version + 1 where id = $1`, [m.faqs[0]!.id]),
      ],
      ['a fact decided', () => inTx(TENANT_A, (ctx) => rejectFact(ctx, m.policy.id, 1))],
    ];
    for (const [, change] of changes) {
      const preview = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx));
      await change();
      const err = await inTx(TENANT_A, (ctx) => approveAll(ctx, {}, preview.previewHash)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PreviewStaleError);
      const fresh = (err as PreviewStaleError).preview;
      expect(fresh.previewHash).not.toBe(preview.previewHash);
      expect(await visible(TENANT_A)).toEqual([]);
      expect(await auditByType(TENANT_A, 'kb.review.approved_all')).toEqual([]);
    }
  });

  it('scopes to one source or one type', async () => {
    const m = await seedMix();
    const bySource: ReviewScope = { sourceId: m.src };
    const p1 = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx, bySource));
    expect(p1).toMatchObject({
      count: 2,
      byType: { product: 1, policy: 1, promotion: 0, faq: 0 },
      excluded: { gstUnknown: 1, conflicted: 1 },
    });
    const r1 = await inTx(TENANT_A, (ctx) => approveAll(ctx, bySource, p1.previewHash));
    expect(r1.facts.map((r) => r.id).sort()).toEqual([m.prices[0]!.id, m.policy.id].sort());
    const [s1] = await auditByType(TENANT_A, 'kb.review.approved_all');
    expect(s1.payload).toMatchObject({ scope: 'source', source: m.src, count: 2 });

    const p2 = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx, { type: 'faq' }));
    expect(p2.count).toBe(2);
    // A hash from another scope doesn't approve this one.
    await expect(
      inTx(TENANT_A, (ctx) => approveAll(ctx, { type: 'product' }, p2.previewHash)),
    ).rejects.toBeInstanceOf(PreviewStaleError);
    await inTx(TENANT_A, (ctx) => approveAll(ctx, { type: 'faq' }, p2.previewHash));
    expect(await row(m.prices[1]!.id)).toMatchObject({ status: 'needs_review' });
  });

  it("never sees or approves another tenant's facts", async () => {
    await seedMix(TENANT_B);
    const preview = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx));
    expect(preview.count).toBe(0);
    await inTx(TENANT_A, (ctx) => approveAll(ctx, {}, preview.previewHash));
    const { rows } = await owner.query(
      `select count(*)::int as n from facts where tenant_id = $1 and status = 'approved'`,
      [TENANT_B],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('bulk selection (UC-15 3; AC-4)', () => {
  it('applies each eligible ref and skips the rest with reasons', async () => {
    const ok1 = await seedFact(TENANT_A, faq('Q1?', 'A.'));
    const ok2 = await seedFact(TENANT_A, product('A', 100));
    const unknown = await seedFact(TENANT_A, product('B', 200, 'unknown'));
    const conflicted = await seedFact(TENANT_A, faq('Q3?', 'A.'));
    await owner.query(`update facts set status = 'conflicted' where id = $1`, [conflicted.id]);
    const changed = await seedFact(TENANT_A, faq('Q4?', 'A.'));
    await owner.query(`update facts set version = 2 where id = $1`, [changed.id]);
    const foreign = await seedFact(TENANT_B, faq('Q5?', 'A.'));

    const res = await inTx(TENANT_A, (ctx) =>
      approveSelected(ctx, [ok1, ok2, unknown, conflicted, changed, foreign]),
    );
    expect(res.approved.map((r) => r.id).sort()).toEqual([ok1.id, ok2.id].sort());
    expect(res.skipped).toEqual([
      { id: unknown.id, reason: 'gst_unknown' },
      { id: conflicted.id, reason: 'conflicted' },
      { id: changed.id, reason: 'changed' },
      { id: foreign.id, reason: 'not_found' },
    ]);
    expect((await auditOf(ok1.id)).at(-1)).toMatchObject({
      event_type: 'fact.approved',
      payload: { version: 2, mode: 'bulk' },
    });
    expect((await auditByType(TENANT_A, 'kb.review.approved_bulk')).map((a) => a.payload)).toEqual([
      { count: 2 },
    ]);
    expect(await row(foreign.id)).toMatchObject({ status: 'needs_review', version: 1 });

    // Already decided → not reviewable.
    const again = await inTx(TENANT_A, (ctx) => approveSelected(ctx, [{ id: ok1.id, version: 2 }]));
    expect(again).toEqual({ approved: [], skipped: [{ id: ok1.id, reason: 'not_reviewable' }] });
    expect(await auditByType(TENANT_A, 'kb.review.approved_bulk')).toHaveLength(1);
  });

  it('rejects a selection, GST-unknown prices included', async () => {
    const a = await seedFact(TENANT_A, faq('Q1?', 'A.'));
    const b = await seedFact(TENANT_A, product('B', 200, 'unknown'));
    const res = await inTx(TENANT_A, (ctx) => rejectSelected(ctx, [a, b]));
    expect(res.rejected.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(res.skipped).toEqual([]);
    expect((await auditByType(TENANT_A, 'kb.review.rejected_bulk')).map((x) => x.payload)).toEqual([
      { count: 2 },
    ]);
    expect((await auditOf(b.id)).at(-1)).toMatchObject({
      event_type: 'fact.rejected',
      payload: { version: 2, mode: 'bulk' },
    });
  });
});

describe('undo (D5; AC-6)', () => {
  it('puts an approval or rejection back in review', async () => {
    const a = await seedFact(TENANT_A, faq('Q1?', 'A.'));
    const b = await seedFact(TENANT_A, faq('Q2?', 'A.'));
    const approved = await inTx(TENANT_A, (ctx) => approveFact(ctx, a.id, 1));
    const rejected = await inTx(TENANT_A, (ctx) => rejectFact(ctx, b.id, 1));
    expect(await visible(TENANT_A)).toEqual([a.id]);
    const res = await inTx(TENANT_A, (ctx) =>
      undoReview(ctx, [
        { id: a.id, version: approved.version },
        { id: b.id, version: rejected.version },
      ]),
    );
    expect(res).toEqual({ restored: 2, skipped: [] });
    expect(await row(a.id)).toMatchObject({ status: 'needs_review', version: 3, chunk_version: 3 });
    expect(await visible(TENANT_A)).toEqual([]);
    expect((await auditOf(a.id)).at(-1)).toMatchObject({
      event_type: 'fact.review_undone',
      actor_ref: USER,
      payload: { version: 3, from: 'approved' },
    });
    expect((await auditOf(b.id)).at(-1)).toMatchObject({ payload: { from: 'rejected' } });
    // The undone facts are reviewable again.
    await inTx(TENANT_A, (ctx) => approveFact(ctx, a.id, 3));
  });

  it('refuses a changed fact, a manual fact, an old decision and another tenant', async () => {
    const a = await seedFact(TENANT_A, faq('Q1?', 'A.'));
    await inTx(TENANT_A, (ctx) => approveFact(ctx, a.id, 1));
    const manual = await inTx(TENANT_A, async (ctx) =>
      createFact(ctx, faq('M?', 'A.'), await prepareChunk(llm, TENANT_A, faq('M?', 'A.'))),
    );
    const old = await seedFact(TENANT_A, faq('Q2?', 'A.'));
    await inTx(TENANT_A, (ctx) => approveFact(ctx, old.id, 1));
    await owner.query(`update facts set updated_at = now() - interval '11 minutes' where id = $1`, [
      old.id,
    ]);
    const res = await inTx(TENANT_A, (ctx) =>
      undoReview(ctx, [
        { id: a.id, version: 1 },
        { id: manual.id, version: 1 },
        { id: old.id, version: 2 },
      ]),
    );
    expect(res).toEqual({
      restored: 0,
      skipped: [
        { id: a.id, reason: 'changed' },
        { id: manual.id, reason: 'not_reviewable' },
        { id: old.id, reason: 'not_reviewable' },
      ],
    });
    const foreign = await inTx(TENANT_B, (ctx) => undoReview(ctx, [{ id: a.id, version: 2 }]));
    expect(foreign.skipped).toEqual([{ id: a.id, reason: 'not_found' }]);
    expect(await row(a.id)).toMatchObject({ status: 'approved', version: 2 });
  });
});

describe('scale (AC-8 chain, AC-10)', () => {
  it('approves 500 facts in one Approve all within 10 s, one entry each, chain verifies', async () => {
    await owner.query(
      `insert into facts (tenant_id, type, status, value, source)
       select $1, 'faq', 'needs_review',
              jsonb_build_object('question', 'Q' || i || '?', 'answer', 'A.'), 'website'
       from generate_series(1, 500) i`,
      [TENANT_A],
    );
    await owner.query(
      `insert into fact_versions (tenant_id, fact_id, version, status, value)
       select tenant_id, id, 1, status, value from facts where tenant_id = $1`,
      [TENANT_A],
    );
    const preview = await inTx(TENANT_A, (ctx) => previewApproveAll(ctx));
    expect(preview.count).toBe(500);
    const started = Date.now();
    const { facts } = await inTx(TENANT_A, (ctx) => approveAll(ctx, {}, preview.previewHash));
    const ms = Date.now() - started;
    console.warn(`FEAT-013 AC-10: Approve all of 500 facts in ${ms} ms`);
    expect(facts).toHaveLength(500);
    expect(ms).toBeLessThan(10_000);
    expect(await auditByType(TENANT_A, 'fact.approved')).toHaveLength(500);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});
