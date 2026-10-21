import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  createWebsiteSource,
  dashboardKb,
  dnsResolver,
  fakeExtractScript,
  parseWebsite,
  runIngestJob,
  type IngestJobBody,
  type PageFetcherFactory,
} from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serveFixtureSite } from '../fixtures/serve.js';
import {
  BAKERY_EXPECTED,
  ELSEWHERE,
  FIXTURE_DOMAIN,
  PRODUCTS,
  productLine,
} from '../fixtures/site.js';
import { chromiumFetchers, parseHostMap, type ChromiumFetchers } from '../src/chromium.js';

// CI installs playwright-core's Chromium; elsewhere CHROMIUM_EXECUTABLE_PATH can name one.
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
const ROOT = `https://${FIXTURE_DOMAIN}`;
const HOSTS = [FIXTURE_DOMAIN, `www.${FIXTURE_DOMAIN}`];
/** The fixture domain resolves to a public address; anything else really resolves. */
const resolve = async (host: string) =>
  host === FIXTURE_DOMAIN ? ['93.184.216.34'] : dnsResolver(host);

let site: Awaited<ReturnType<typeof serveFixtureSite>>;
let browser: ChromiumFetchers;

beforeAll(async () => {
  site = await serveFixtureSite();
  browser = chromiumFetchers({
    executablePath,
    resolve,
    hostMap: parseHostMap(`${FIXTURE_DOMAIN}=${site.origin}`),
  });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const pathsOf = (requests: string[]) => [...new Set(requests)];

describe('Chromium fetcher (FEAT-012 §5.2, D3)', () => {
  it('renders a JavaScript-only page and reads its text, title and links', async () => {
    site.variant = 'bakery';
    const f = await browser.open({ hosts: HOSTS });
    try {
      const page = await f.page(`${ROOT}/js-only`);
      expect(page).toMatchObject({
        ok: true,
        finalUrl: `${ROOT}/js-only`,
        httpStatus: 200,
        contentType: 'text/html; charset=utf-8',
        title: 'Kaya toast — Kaki Bakery',
      });
      if (!page.ok) throw new Error('unreachable');
      expect(page.text).toContain('Kaya toast box (4 sets) — S$12.00');
      expect(page.links).toContain(`${ROOT}/products`);
    } finally {
      await f.close?.();
    }
  });

  it('sees an off-domain redirect without requesting the other host, and reports a 404', async () => {
    site.variant = 'bakery';
    const f = await browser.open({ hosts: HOSTS });
    try {
      expect(await f.page(`${ROOT}/go-elsewhere`)).toMatchObject({
        ok: true,
        finalUrl: `https://${ELSEWHERE}/shop`,
      });
      expect(await f.page(`${ROOT}/old-faq`)).toMatchObject({ ok: true, finalUrl: `${ROOT}/faq` });
      expect(await f.page(`${ROOT}/missing`)).toMatchObject({ ok: true, httpStatus: 404 });
      expect(await f.page(`${ROOT}/menu.pdf`)).toMatchObject({
        ok: true,
        contentType: 'application/pdf',
        text: '',
      });
      expect(await f.robots(ROOT)).toEqual({
        status: 200,
        body: expect.stringContaining('Disallow: /private/'),
      });
    } finally {
      await f.close?.();
    }
  });

  it('aborts any request to a non-public address with the guard on (D7)', async () => {
    site.variant = 'guard';
    const before = site.requests.length;
    const f = await browser.open({ hosts: [...HOSTS, `shop.${FIXTURE_DOMAIN}`, '127.0.0.1'] });
    try {
      // The page loads; its script on localhost is never requested.
      const page = await f.page(`${ROOT}/`);
      expect(page).toMatchObject({ ok: true, httpStatus: 200 });
      // A page on a host that doesn't resolve publicly is never requested at all.
      expect(await f.page(`https://shop.${FIXTURE_DOMAIN}/`)).toEqual({
        ok: false,
        reason: 'blocked_address',
      });
      expect(await f.page(`http://127.0.0.1:${site.port}/next`)).toEqual({
        ok: false,
        reason: 'blocked_address',
      });
      expect(await f.robots(`http://127.0.0.1:${site.port}`)).toBeNull();
    } finally {
      await f.close?.();
    }
    const asked = site.requests.slice(before);
    expect(asked).toEqual(['/']);
  });
});

describe('ingest worker end to end on the fixture site (AC-2, AC-4, AC-11)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  const llm = gatewayFromConfig({ provider: 'fake', fakeScript: fakeExtractScript });

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
    for (const t of ['kb_staged_facts', 'kb_source_pages']) await owner.query(`delete from ${t}`);
    await owner.query(
      `delete from kb_chunks where fact_id in (select id from facts where source_id is not null)`,
    );
    await owner.query(
      `delete from fact_versions where fact_id in (select id from facts where source_id is not null)`,
    );
    await owner.query(`delete from facts where source_id is not null`);
    await owner.query(`delete from kb_sources`);
  });

  async function addSource(pageLimit: number) {
    return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createWebsiteSource(dashboardKb(tx, TENANT_A, 'user-owner-1'), parseWebsite(ROOT), {
        pageLimit,
      }),
    );
  }

  /** The dispatcher and the worker's consumer, in one loop. */
  async function run(sourceId: string, fetcher: PageFetcherFactory) {
    const started = Date.now();
    const outcomes = [];
    for (;;) {
      const { rows } = await owner.query(
        `update outbox set dispatched_at = now() where id = (
           select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
         returning payload`,
        [sourceId],
      );
      if (!rows[0]) break;
      outcomes.push(
        await runIngestJob(
          { zdb: tdb.zone('ingest'), llm, fetcher, crawl: { concurrency: 4 } },
          rows[0].payload as IngestJobBody,
          1,
        ),
      );
    }
    return { outcomes, ms: Date.now() - started };
  }

  it(
    'crawls the bakery site in Chromium and promotes its facts for review within 5 minutes',
    async () => {
      site.variant = 'bakery';
      const before = site.requests.length;
      const s = await addSource(100);
      const { outcomes, ms } = await run(s.id, browser.open);
      console.warn(`FEAT-012 AC-11: bakery fixture site crawled to ready in ${ms} ms`);
      expect(ms).toBeLessThan(5 * 60_000);
      expect(outcomes.at(-1)).toMatchObject({ result: 'ready' });

      const { rows: pages } = await owner.query(
        `select url, status, reason, http_status, content from kb_source_pages where source_id = $1`,
        [s.id],
      );
      const byPath = Object.fromEntries(
        pages.map((p) => [new URL(p.url).pathname, [p.status, p.reason]]),
      );
      const expected = {
        ...Object.fromEntries(BAKERY_EXPECTED.included.map((p) => [p, ['included', null]])),
        ...Object.fromEntries(
          Object.entries(BAKERY_EXPECTED.excluded).map(([p, r]) => [p, ['excluded', r]]),
        ),
        ...Object.fromEntries(
          Object.entries(BAKERY_EXPECTED.failed).map(([p, r]) => [p, ['failed', r]]),
        ),
      };
      expect(byPath).toEqual(expected);
      expect(pages.find((p) => p.url.endsWith('/missing')).http_status).toBe(404);
      expect(pages.find((p) => p.url.endsWith('/js-only')).content).toContain(
        'Kaya toast box (4 sets) — S$12.00',
      );
      // Robots-excluded pages and other hosts are never requested (AC-2).
      const asked = pathsOf(site.requests.slice(before));
      expect(asked.filter((p) => p.startsWith('/private/'))).toEqual([]);
      expect(asked).not.toContain('/shop');
      expect(asked).not.toContain('/hello');

      const { rows: facts } = await owner.query(
        `select type, status, value, gst_treatment, provenance from facts where source_id = $1`,
        [s.id],
      );
      expect(facts.every((f) => f.status === 'needs_review')).toBe(true);
      const products = facts.filter((f) => f.type === 'product');
      expect(products).toHaveLength(PRODUCTS.length + 1);
      for (const p of PRODUCTS) {
        const fact = products.find((f) => f.value.name === p[1]);
        expect(fact?.provenance.quote).toBe(productLine(p));
        expect(fact?.gst_treatment).toBe(
          p[4] === null ? 'unknown' : p[4] === 'GST incl.' ? 'inclusive' : 'exclusive',
        );
      }
      expect(facts.filter((f) => f.type === 'faq')).toHaveLength(3);
      expect(facts.filter((f) => f.type === 'policy')).toHaveLength(2);
      expect(facts.filter((f) => f.type === 'promotion')).toHaveLength(1);
      const { rows: visible } = await owner.query(
        `select count(*)::int as n from visitor_facts where id in (select id from facts where source_id = $1)`,
        [s.id],
      );
      expect(visible[0].n).toBe(0);
    },
    5 * 60_000,
  );

  it(
    'crawls a 200-page site to ready within 15 minutes (NFR-16)',
    async () => {
      site.variant = { pages: 200 };
      const s = await addSource(200);
      const { outcomes, ms } = await run(s.id, browser.open);
      console.warn(`FEAT-012 AC-11: 200-page fixture site crawled to ready in ${ms} ms`);
      expect(ms).toBeLessThan(15 * 60_000);
      expect(outcomes.at(-1)).toEqual({ result: 'ready', facts: 200 });
    },
    15 * 60_000,
  );
});
