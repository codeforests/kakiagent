import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;

/** Fixed DNS: two public sites and one that resolves to a private address. */
const DNS: Record<string, string[]> = {
  'kakibakery.sg': ['93.184.216.34'],
  'www.kakibakery.sg': ['93.184.216.34'],
  'shop.kakibakery.sg': ['93.184.216.34'],
  'sweets.sg': ['93.184.216.35'],
  'intranet.example.sg': ['10.0.0.12'],
};
const resolve = async (host: string) => {
  const a = DNS[host];
  if (!a) throw new Error('ENOTFOUND');
  return a;
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { resolve, env: { CRAWL_PAGE_LIMIT: '100' } });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
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
  await owner.query(`delete from outbox where topic = 'ingest'`);
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const site = { kind: 'website', url: 'kakibakery.sg', attested: true };
const count = async (q: string, args: unknown[] = []) =>
  Number((await owner.query(q, args)).rows[0].n);

async function add(body: object = site) {
  const res = await call('POST', '/api/v1/kb/sources', asA, body);
  expect(res.statusCode).toBe(201);
  return res.json().source;
}

describe('create (AC-1; KB-13, UC-03 4, 4b)', () => {
  it('refuses without the attestation and writes nothing', async () => {
    const audits = await count(`select count(*) as n from audit_entries`);
    for (const attested of [undefined, false]) {
      const res = await call('POST', '/api/v1/kb/sources', asA, { ...site, attested });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('attestation_required');
    }
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
    expect(await count(`select count(*) as n from outbox where topic = 'ingest'`)).toBe(0);
    expect(await count(`select count(*) as n from audit_entries`)).toBe(audits);
  });

  it('creates a queued source with the attestation, audit, origins and crawl job', async () => {
    const source = await add({ ...site, subdomains: ['shop.kakibakery.sg'] });
    expect(source).toMatchObject({
      kind: 'website',
      status: 'queued',
      stage: 'crawl',
      name: 'kakibakery.sg',
      url: 'https://kakibakery.sg/',
      subdomains: ['shop.kakibakery.sg'],
      pageLimit: 100,
      failure: null,
      counts: { pagesFound: 0, facts: 0, factsNeedingReview: 0 },
      version: 1,
    });
    const row = (await owner.query(`select attested_by, attested_at from kb_sources`)).rows[0];
    expect(row.attested_by).toBeTruthy();
    expect(row.attested_at).toBeTruthy();
    const audits = (
      await owner.query(
        `select event_type, payload from audit_entries
         where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
        [source.id],
      )
    ).rows;
    expect(audits.map((a) => a.event_type)).toEqual(['kb_source.attested', 'kb_source.created']);
    expect(JSON.stringify(audits)).not.toContain('kakibakery');
    const { rows } = await owner.query(`select allowed_origins from tenants where id = $1`, [
      TENANT_A,
    ]);
    expect(rows[0].allowed_origins).toEqual(
      expect.arrayContaining([
        'https://kakibakery.sg',
        'https://www.kakibakery.sg',
        'https://shop.kakibakery.sg',
      ]),
    );
    expect(await count(`select count(*) as n from outbox where topic = 'ingest'`)).toBe(1);
  });

  it.each([
    ['an IP literal', { url: 'http://93.184.216.34/' }, 'bad_request'],
    ['localhost', { url: 'http://localhost/' }, 'bad_request'],
    ['a port', { url: 'https://kakibakery.sg:8443/' }, 'bad_request'],
    ['a subdomain of another domain', { subdomains: ['shop.sweets.sg'] }, 'bad_request'],
    ['a host on a private address', { url: 'intranet.example.sg' }, 'url_not_public'],
    ['a host that does not resolve', { url: 'nowhere.sg' }, 'url_not_public'],
  ])('refuses %s (D7)', async (_name, patch, error) => {
    const res = await call('POST', '/api/v1/kb/sources', asA, { ...site, ...patch });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
  });

  it('refuses a second source for the same domain with 409 source_exists', async () => {
    const first = await add();
    const res = await call('POST', '/api/v1/kb/sources', asA, {
      ...site,
      url: 'https://www.kakibakery.sg/about',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'source_exists', sourceId: first.id });
  });

  it('is for kb managers only', async () => {
    expect((await call('POST', '/api/v1/kb/sources', asAgent, site)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/kb/sources', asAgent)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/kb/sources' })).statusCode).toBe(401);
  });
});

describe('list, detail, retry and delete (AC-7, AC-9; KB-12, KB-07)', () => {
  it('lists newest first with the page limit, and shows the pages of a source', async () => {
    const a = await add();
    const b = await add({ ...site, url: 'sweets.sg' });
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, title, status, reason, http_status)
       values ($1, $2, 1, 0, 'https://kakibakery.sg/', 'Home', 'included', null, 200),
              ($1, $2, 1, 1, 'https://kakibakery.sg/private/x', null, 'excluded', 'robots', null)`,
      [TENANT_A, a.id],
    );
    const list = await call('GET', '/api/v1/kb/sources', asA);
    expect(list.statusCode).toBe(200);
    expect(list.json().pageLimit).toBe(100);
    expect(list.json().sources.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    const detail = await call('GET', `/api/v1/kb/sources/${a.id}`, asA);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().pages).toEqual([
      expect.objectContaining({ url: 'https://kakibakery.sg/', status: 'included', reason: null }),
      expect.objectContaining({ status: 'excluded', reason: 'robots', httpStatus: null }),
    ]);
    // Another tenant's source and a malformed ID are both not found.
    expect((await call('GET', `/api/v1/kb/sources/${a.id}`, asB)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/kb/sources/not-a-uuid`, asA)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/kb/sources', asB)).json().sources).toEqual([]);
  });

  it('retries only a failed source, with its version', async () => {
    const s = await add();
    const early = await call('POST', `/api/v1/kb/sources/${s.id}/retry`, asA, { version: 1 });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('invalid_state');
    await owner.query(
      `update kb_sources set status = 'failed', stage = null, failure = 'no_pages', version = 2`,
    );
    const stale = await call('POST', `/api/v1/kb/sources/${s.id}/retry`, asA, { version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'version_conflict',
      message: 'This source was changed by someone else',
    });
    const ok = await call('POST', `/api/v1/kb/sources/${s.id}/retry`, asA, { version: 2 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().source).toMatchObject({
      status: 'queued',
      stage: 'crawl',
      failure: null,
      version: 3,
    });
    expect(await count(`select attempt as n from kb_sources`)).toBe(2);
  });

  it('deletes a source with its facts; processing and stale versions are 409', async () => {
    const s = await add();
    const { rows } = await owner.query(
      `insert into facts (tenant_id, type, status, value, source, source_id, confidence, provenance, created_by, updated_by)
       values ($1, 'faq', 'approved', '{"question":"Halal?","answer":"No pork or lard."}', 'website', $2, 0.9,
               '{"url":"https://kakibakery.sg/faq","title":"FAQ","quote":"Q: Halal?","start":0,"end":9}', 'u', 'u')
       returning id`,
      [TENANT_A, s.id],
    );
    const factId = rows[0].id;
    // The fact carries its source and provenance, and the facts list filters by source.
    const fact = (await call('GET', `/api/v1/kb/facts/${factId}`, asA)).json().fact;
    expect(fact).toMatchObject({
      sourceId: s.id,
      confidence: 0.9,
      provenance: { sourceId: s.id, url: 'https://kakibakery.sg/faq', quote: 'Q: Halal?' },
    });
    const bySource = await call('GET', `/api/v1/kb/facts?sourceId=${s.id}`, asA);
    expect(bySource.json().facts.map((f: { id: string }) => f.id)).toEqual([factId]);
    expect((await call('GET', `/api/v1/kb/facts?sourceId=nope`, asA)).statusCode).toBe(400);
    const listed = (await call('GET', '/api/v1/kb/sources', asA)).json().sources[0];
    expect(listed.counts).toMatchObject({ facts: 1, factsNeedingReview: 0 });

    await owner.query(`update kb_sources set status = 'processing'`);
    const busy = await call('DELETE', `/api/v1/kb/sources/${s.id}?version=1`, asA);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('invalid_state');
    await owner.query(`update kb_sources set status = 'ready'`);
    expect((await call('DELETE', `/api/v1/kb/sources/${s.id}?version=9`, asA)).statusCode).toBe(
      409,
    );
    expect((await call('DELETE', `/api/v1/kb/sources/${s.id}`, asA)).statusCode).toBe(400);
    expect((await call('DELETE', `/api/v1/kb/sources/${s.id}?version=1`, asB)).statusCode).toBe(
      404,
    );
    expect((await call('DELETE', `/api/v1/kb/sources/${s.id}?version=1`, asA)).statusCode).toBe(
      204,
    );
    expect(await count(`select count(*) as n from facts where id = $1`, [factId])).toBe(0);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
    const audit = await owner.query(
      `select payload from audit_entries
       where event_type = 'kb_source.deleted' and split_part(subject_refs[1], ':', 2) = $1`,
      [s.id],
    );
    expect(audit.rows[0].payload).toMatchObject({ facts: 1 });
  });
});
