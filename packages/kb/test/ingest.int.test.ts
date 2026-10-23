import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  fakeEmbed,
  gatewayFromConfig,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createWebsiteSource,
  dashboardKb,
  fakeExtractScript,
  parseWebsite,
  retrySource,
  runIngestJob,
  searchVisitorFacts,
  visitorKb,
  type FetchedPage,
  type IngestJobBody,
  type StageJobBody,
  type PageFetcher,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
const ROOT = 'https://kakibakery.sg';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
afterEach(async () => {
  await owner.query(`delete from kb_staged_facts`);
  await owner.query(`delete from kb_source_pages`);
  await owner.query(
    `delete from kb_chunks where fact_id in (select id from facts where source_id is not null)`,
  );
  await owner.query(
    `delete from fact_versions where fact_id in (select id from facts where source_id is not null)`,
  );
  await owner.query(`delete from facts where source_id is not null`);
  await owner.query(`delete from kb_sources`);
});

type SitePage =
  | {
      title?: string;
      text: string;
      links?: string[];
      status?: number;
      type?: string;
      redirect?: string;
    }
  | { fail: 'timeout' | 'blocked_address' | 'load_error' };

/** A scripted site behind the PageFetcher interface (FEAT-012 D3), logging every request. */
function fakeSite(
  pages: Record<string, SitePage>,
  robots: { status: number; body: string } | null = { status: 404, body: '' },
) {
  const requested: string[] = [];
  const fetcher: PageFetcher = {
    async robots() {
      return robots;
    },
    async page(url): Promise<FetchedPage> {
      requested.push(url);
      const p = pages[url];
      if (!p)
        return {
          ok: true,
          finalUrl: url,
          httpStatus: 404,
          contentType: 'text/html',
          title: 'Not found',
          text: '',
          links: [],
        };
      if ('fail' in p) return { ok: false, reason: p.fail };
      return {
        ok: true,
        finalUrl: p.redirect ?? url,
        httpStatus: p.status ?? 200,
        contentType: p.type ?? 'text/html; charset=utf-8',
        title: p.title ?? '',
        text: p.text,
        links: p.links ?? [],
      };
    },
  };
  return { fetcher, requested };
}

const BAKERY: Record<string, SitePage> = {
  [`${ROOT}/`]: {
    title: 'Kaki Bakery',
    text: 'Welcome to Kaki Bakery. Fresh cakes daily. Call S1234567D for nothing.',
    links: [
      '/cakes',
      '/faq',
      '/policies',
      'https://other.sg/x',
      '/private/staff',
      '/menu.pdf',
      '/gone',
      '/copy',
      '/away',
      'mailto:hi@kakibakery.sg',
      '#top',
    ],
  },
  [`${ROOT}/cakes`]: {
    title: 'Cakes',
    text: 'Our cakes\nChocolate fudge cake (1 kg) — S$55.00\nPandan chiffon — S$28.50 (GST incl.)\nPromotion: Deepavali box — 12 kueh for S$20 until 2099-11-10',
    links: ['/', '/faq'],
  },
  [`${ROOT}/faq`]: {
    title: 'FAQ',
    text: 'Q: Do you have eggless cakes?\nA: Yes, order 3 days ahead.\nChocolate fudge cake (1 kg) — S$55.00',
  },
  [`${ROOT}/policies`]: {
    title: 'Policies',
    text: 'Refund policy: Cancel at least 2 days before collection for a full refund.',
  },
  [`${ROOT}/menu.pdf`]: { text: '%PDF', type: 'application/pdf' },
  [`${ROOT}/copy`]: {
    title: 'Copy',
    text: 'Q: Do you have eggless cakes?\nA: Yes, order 3 days ahead.\nChocolate fudge cake (1 kg) — S$55.00',
  },
  [`${ROOT}/away`]: { text: 'elsewhere', redirect: 'https://other.sg/landing' },
  [`${ROOT}/private/staff`]: { text: 'staff only' },
};
const ROBOTS = { status: 200, body: 'User-agent: *\nDisallow: /private/' };

const dash = <T>(tenantId: string, fn: (ctx: ReturnType<typeof dashboardKb>) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => fn(dashboardKb(tx, tenantId, USER)));

async function addSource(tenantId = TENANT_A, pageLimit = 100, url = `${ROOT}/`) {
  return dash(tenantId, (ctx) => createWebsiteSource(ctx, parseWebsite(url), { pageLimit }));
}

const llm = gatewayFromConfig({ provider: 'fake', fakeScript: fakeExtractScript });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a raw row, snake_case
async function source(id: string): Promise<any> {
  const { rows } = await owner.query(`select * from kb_sources where id = $1`, [id]);
  return rows[0];
}

async function pages(id: string) {
  return (
    await owner.query(
      `select url, status, reason, http_status, content, facts_count from kb_source_pages where source_id = $1 order by seq`,
      [id],
    )
  ).rows;
}

/** Runs the jobs the outbox holds for a source, like the dispatcher and the worker would. */
async function drain(
  s: { id: string; tenantId: string },
  fetcher: PageFetcher,
  opts: { llm?: typeof llm; receiveCount?: number; jobs?: number } = {},
) {
  const outcomes = [];
  for (let i = 0; i < (opts.jobs ?? 10); i++) {
    const { rows } = await owner.query(
      `update outbox set dispatched_at = now() where id = (
         select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
       returning payload`,
      [s.id],
    );
    if (!rows[0]) break;
    outcomes.push(
      await runIngestJob(
        { zdb: tdb.zone('ingest'), llm: opts.llm ?? llm, fetcher, crawl: { concurrency: 3 } },
        rows[0].payload as IngestJobBody,
        opts.receiveCount ?? 1,
      ),
    );
  }
  return outcomes;
}

describe('crawl stage (KB-01, KB-13; FEAT-012 §5.2)', () => {
  it('lists every in-scope page with its result and never requests robots-blocked or other hosts', async () => {
    const s = await addSource();
    const { fetcher, requested } = fakeSite(BAKERY, ROBOTS);
    const out = await drain(s, fetcher, { jobs: 1 });
    expect(out[0]).toEqual({ result: 'next', stage: 'extract' });
    const list = await pages(s.id);
    const byUrl = Object.fromEntries(list.map((p) => [p.url, [p.status, p.reason, p.http_status]]));
    expect(byUrl).toEqual({
      [`${ROOT}/`]: ['included', null, 200],
      [`${ROOT}/cakes`]: ['included', null, 200],
      [`${ROOT}/faq`]: ['included', null, 200],
      [`${ROOT}/policies`]: ['included', null, 200],
      [`${ROOT}/private/staff`]: ['excluded', 'robots', null],
      [`${ROOT}/menu.pdf`]: ['excluded', 'not_html', 200],
      [`${ROOT}/gone`]: ['failed', 'http_error', 404],
      [`${ROOT}/copy`]: ['excluded', 'duplicate', 200],
      [`${ROOT}/away`]: ['excluded', 'off_domain_redirect', null],
    });
    expect(requested).not.toContain(`${ROOT}/private/staff`);
    expect(requested.some((u) => u.includes('other.sg'))).toBe(false);
    // ADR-015: an NRIC on a page is masked before it is stored.
    const home = list.find((p) => p.url === `${ROOT}/`)!;
    expect(home.content).not.toContain('S1234567D');
    const src = await source(s.id);
    expect(src).toMatchObject({
      status: 'processing',
      stage: 'extract',
      pages_found: 9,
      pages_included: 4,
      pages_excluded: 4,
      pages_failed: 1,
      pages_skipped: 0,
    });
  });

  it('stops at the page limit and lists the rest as skipped without fetching them (UC-03 5b)', async () => {
    const site: Record<string, SitePage> = {};
    for (let i = 0; i < 150; i++)
      site[`${ROOT}/p${i}`] = {
        title: `P${i}`,
        text: `Page ${i} text long enough to keep`,
        links: [`/p${i + 1}`, `/p${i + 2}`],
      };
    site[`${ROOT}/`] = { text: 'Home page with enough text', links: ['/p0'] };
    const s = await addSource(TENANT_A, 100);
    const { fetcher, requested } = fakeSite(site);
    await drain(s, fetcher, { jobs: 1 });
    const list = await pages(s.id);
    expect(list.filter((p) => p.status === 'included')).toHaveLength(100);
    const skipped = list.filter((p) => p.status === 'skipped');
    expect(skipped.every((p) => p.reason === 'plan_limit')).toBe(true);
    for (const p of skipped) expect(requested).not.toContain(p.url);
    expect(requested).toHaveLength(100);
    // AC-3: every page discovered past the limit is listed as skipped, and nothing else is.
    const discovered = new Set(
      requested.flatMap((u) => {
        const p = site[u];
        return p && !('fail' in p) ? (p.links ?? []).map((l) => new URL(l, u).href) : [];
      }),
    );
    const beyond = [...discovered].filter((u) => !requested.includes(u)).sort();
    expect(beyond.length).toBeGreaterThan(0);
    expect(skipped.map((p) => p.url).sort()).toEqual(beyond);
    expect(list).toHaveLength(100 + beyond.length);
  });

  it('fails no_pages when robots blocks everything, and site_unreachable when every fetch fails', async () => {
    const blocked = await addSource();
    const a = fakeSite(BAKERY, { status: 200, body: 'User-agent: *\nDisallow: /' });
    expect(await drain(blocked, a.fetcher)).toEqual([{ result: 'failed', failure: 'no_pages' }]);
    expect(a.requested).toEqual([]);
    expect(await pages(blocked.id)).toEqual([
      expect.objectContaining({ status: 'excluded', reason: 'robots' }),
    ]);
    expect(await source(blocked.id)).toMatchObject({
      status: 'failed',
      failure: 'no_pages',
      stage: null,
    });

    const down = await addSource(TENANT_B, 100, 'https://down.sg/');
    const b = fakeSite({ 'https://down.sg/': { fail: 'timeout' } });
    expect(await drain(down, b.fetcher)).toEqual([
      { result: 'failed', failure: 'site_unreachable' },
    ]);
  });
});

describe('extract and promote (KB-05, KB-12, KB-16; FEAT-012 §5.3–5.4)', () => {
  it('a full run ends ready with needs_review facts carrying provenance, none visible to visitors', async () => {
    const s = await addSource();
    const { fetcher } = fakeSite(BAKERY, ROBOTS);
    const out = await drain(s, fetcher);
    expect(out.map((o) => o.result)).toEqual(['next', 'next', 'ready']);
    const facts = (
      await owner.query(
        `select f.type, f.status, f.value, f.gst_treatment, f.source, f.confidence, f.provenance, f.version,
                (select count(*)::int from fact_versions v where v.fact_id = f.id) as versions,
                (select count(*)::int from kb_chunks c where c.fact_id = f.id) as chunks
         from facts f where f.source_id = $1 order by f.type, f.value->>'name'`,
        [s.id],
      )
    ).rows;
    // The fudge cake is on two pages and the copy page is a duplicate: one fact each.
    expect(
      facts.map((f) => [
        f.type,
        f.value.name ?? f.value.title ?? f.value.question,
        f.gst_treatment,
      ]),
    ).toEqual([
      ['faq', 'Do you have eggless cakes?', null],
      ['policy', 'Refund policy', null],
      ['product', 'Chocolate fudge cake', 'unknown'],
      ['product', 'Pandan chiffon', 'inclusive'],
      ['promotion', 'Deepavali box', 'unknown'],
    ]);
    for (const f of facts) {
      expect(f).toMatchObject({
        status: 'needs_review',
        source: 'website',
        version: 1,
        versions: 1,
        chunks: 1,
      });
      expect(f.confidence).toBeCloseTo(0.9);
    }
    const contentOf = Object.fromEntries((await pages(s.id)).map((p) => [p.url, p.content]));
    for (const f of facts) {
      const { url, quote, start, end } = f.provenance;
      expect(contentOf[url].slice(start, end)).toBe(quote);
    }
    expect(await source(s.id)).toMatchObject({
      status: 'ready',
      stage: null,
      facts_count: 5,
      pages_extracted: 4,
    });
    expect(
      (await owner.query(`select 1 from kb_staged_facts where source_id = $1`, [s.id])).rowCount,
    ).toBe(0);
    const audit = await owner.query(
      `select event_type, actor_type, payload from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [s.id],
    );
    expect(audit.rows.at(-1)).toEqual({
      event_type: 'kb_source.promoted',
      actor_type: 'system',
      payload: { facts: 5, attempt: 1 },
    });
    // KB-16: nothing extracted reaches a visitor until it is approved.
    const hits = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      searchVisitorFacts(
        visitorKb(tx, TENANT_A, '00000000-0000-4000-8000-0000000000c1'),
        fakeEmbed('chocolate fudge cake price'),
        { k: 50, maxDistance: 2 },
      ),
    );
    const ids = facts.map((f) => f.id);
    expect(hits.some((h) => ids.includes(h.id))).toBe(false);
    expect(hits.some((h) => h.type === 'product' && h.value.name === 'Pandan chiffon')).toBe(false);
  });

  it('a failing extractor leaves the source queued between redeliveries, then failed with no facts or staging', async () => {
    let calls = 0;
    // Two pages extract (the home page and the cakes), then the provider goes down.
    const flaky = createGateway(defaultRegistry('fake'), [
      createFakeProvider((req) => {
        if (calls++ >= 2) throw new Error('provider down');
        return fakeExtractScript(req);
      }),
    ]);
    const zdb = tdb.zone('ingest');
    const t = await addSource(TENANT_B, 100, 'https://flaky.sg/');
    const site = fakeSite(
      Object.fromEntries(
        Object.entries(BAKERY).map(([u, p]) => [u.replace(ROOT, 'https://flaky.sg'), p]),
      ),
      ROBOTS,
    );
    const job = (stage: StageJobBody['stage']): StageJobBody => ({
      tenantId: TENANT_B,
      sourceId: t.id,
      attempt: 1,
      stage,
    });
    expect(await runIngestJob({ zdb, llm: flaky, fetcher: site.fetcher }, job('crawl'), 1)).toEqual(
      { result: 'next', stage: 'extract' },
    );
    await expect(
      runIngestJob(
        { zdb, llm: flaky, fetcher: site.fetcher, extract: { concurrency: 1 } },
        job('extract'),
        1,
      ),
    ).rejects.toThrow();
    expect(await source(t.id)).toMatchObject({ status: 'queued', stage: 'extract' });
    expect((await source(t.id)).pages_extracted).toBeGreaterThanOrEqual(1);
    const staged = (await owner.query(`select 1 from kb_staged_facts where source_id = $1`, [t.id]))
      .rowCount;
    expect(staged).toBeGreaterThan(0);
    expect(
      await runIngestJob({ zdb, llm: flaky, fetcher: site.fetcher }, job('extract'), 5),
    ).toEqual({
      result: 'failed',
      failure: 'extraction_unavailable',
    });
    expect(await source(t.id)).toMatchObject({
      status: 'failed',
      failure: 'extraction_unavailable',
      stage: null,
    });
    expect(
      (await owner.query(`select 1 from kb_staged_facts where source_id = $1`, [t.id])).rowCount,
    ).toBe(0);
    expect((await owner.query(`select 1 from facts where source_id = $1`, [t.id])).rowCount).toBe(
      0,
    );

    // The jobs above were run by hand; mark theirs consumed, as the queue would have.
    await owner.query(`update outbox set dispatched_at = now() where group_key = $1`, [t.id]);
    // Retry runs it again as attempt 2 and, with the provider back, ends ready (AC-7).
    const failed = await source(t.id);
    await dash(TENANT_B, (ctx) => retrySource(ctx, t.id, failed.version));
    const out = await drain({ id: t.id, tenantId: TENANT_B }, site.fetcher);
    expect(out.map((o) => o.result)).toEqual(['next', 'next', 'ready']);
    expect(await source(t.id)).toMatchObject({ status: 'ready', attempt: 2, facts_count: 5 });
  });

  it('resumes extraction after a crash without re-extracting finished pages (AC-8)', async () => {
    const s = await addSource();
    const { fetcher } = fakeSite(BAKERY, ROBOTS);
    const zdb = tdb.zone('ingest');
    const job = (stage: StageJobBody['stage']): StageJobBody => ({
      tenantId: TENANT_A,
      sourceId: s.id,
      attempt: 1,
      stage,
    });
    await runIngestJob({ zdb, llm, fetcher }, job('crawl'), 1);
    let calls = 0;
    const dying = createGateway(defaultRegistry('fake'), [
      createFakeProvider((req) => {
        if (calls++ === 2) throw new Error('worker killed');
        return fakeExtractScript(req);
      }),
    ]);
    await expect(
      runIngestJob({ zdb, llm: dying, fetcher, extract: { concurrency: 1 } }, job('extract'), 1),
    ).rejects.toThrow();
    const done = (await source(s.id)).pages_extracted;
    expect(done).toBe(2);
    let resumed = 0;
    const counting = createGateway(defaultRegistry('fake'), [
      createFakeProvider((req) => {
        resumed++;
        return fakeExtractScript(req);
      }),
    ]);
    expect(await runIngestJob({ zdb, llm: counting, fetcher }, job('extract'), 2)).toEqual({
      result: 'next',
      stage: 'promote',
    });
    expect(resumed).toBe(4 - done);
  });

  it('ignores duplicate and stale jobs (NFR-17, AC-8)', async () => {
    const s = await addSource();
    const { fetcher } = fakeSite(BAKERY, ROBOTS);
    const zdb = tdb.zone('ingest');
    const crawl: IngestJobBody = { tenantId: TENANT_A, sourceId: s.id, attempt: 1, stage: 'crawl' };
    await drain(s, fetcher);
    const before = await source(s.id);
    expect(await runIngestJob({ zdb, llm, fetcher }, crawl, 1)).toEqual({ result: 'stale' });
    expect(await runIngestJob({ zdb, llm, fetcher }, { ...crawl, stage: 'promote' }, 1)).toEqual({
      result: 'stale',
    });
    expect(await runIngestJob({ zdb, llm, fetcher }, { ...crawl, attempt: 7 }, 1)).toEqual({
      result: 'stale',
    });
    expect(
      await runIngestJob(
        { zdb, llm, fetcher },
        { ...crawl, sourceId: '00000000-0000-4000-8000-000000000999' },
        1,
      ),
    ).toEqual({
      result: 'stale',
    });
    expect(await source(s.id)).toMatchObject({
      status: before.status,
      facts_count: before.facts_count,
      version: before.version,
    });
    expect(
      (await owner.query(`select count(*)::int as n from facts where source_id = $1`, [s.id]))
        .rows[0].n,
    ).toBe(5);
  });

  it('skips extracted facts the tenant already has word for word, and keeps tenants apart', async () => {
    await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment) values ($1, 'faq', 'approved',
         '{"question":"Do you have eggless cakes?","answer":"Yes, order 3 days ahead."}', null)`,
      [TENANT_A],
    );
    try {
      const s = await addSource();
      await drain(s, fakeSite(BAKERY, ROBOTS).fetcher);
      expect(await source(s.id)).toMatchObject({ status: 'ready', facts_count: 4 });
      expect(
        (
          await owner.query(`select 1 from facts where tenant_id = $1 and source_id is not null`, [
            TENANT_B,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await owner.query(
        `delete from facts where tenant_id = $1 and source = 'manual' and type = 'faq' and value->>'question' = 'Do you have eggless cakes?'`,
        [TENANT_A],
      );
    }
  });
});
