/**
 * Fact review endpoints (FEAT-013 §3; AC-2..AC-6, AC-8; the 500-fact timing is in kb's review tests): the queue, the summary, the
 * Approve all preview and execute, single and bulk decisions, undo, and the errors.
 */
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

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
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
  for (const t of ['kb_chunks', 'fact_versions', 'facts', 'kb_source_pages', 'kb_sources'])
    await owner.query(`delete from ${t}`);
});

const call = (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const cake = (name: string, price = '55.00') => ({
  type: 'product',
  value: { name, price },
  gstTreatment: 'inclusive',
});
const question = (q: string) => ({ type: 'faq', value: { question: q, answer: 'Yes.' } });

/** A fact created by hand, then put back in review as the crawler would leave it. */
async function seed(
  who: string,
  body: object,
  opts: { gstUnknown?: boolean; sourceId?: string; quote?: string } = {},
) {
  const res = await call('POST', '/api/v1/kb/facts', who, body);
  expect(res.statusCode).toBe(201);
  const id = res.json().fact.id as string;
  await owner.query(
    `update facts set status = 'needs_review', gst_treatment = case when $2 then 'unknown' else gst_treatment end,
       source_id = $3, confidence = case when $3::uuid is null then null else 0.82 end,
       provenance = case when $3::uuid is null then null else $4::jsonb end where id = $1`,
    [
      id,
      opts.gstUnknown ?? false,
      opts.sourceId ?? null,
      JSON.stringify({
        url: 'https://kakibakery.sg/cakes',
        title: 'Cakes',
        quote: opts.quote ?? '',
        start: 4,
        end: 4 + (opts.quote ?? '').length,
      }),
    ],
  );
  await owner.query(`update fact_versions set status = 'needs_review' where fact_id = $1`, [id]);
  return id;
}

async function seedSource(tenantId: string, content: string) {
  const { rows } = await owner.query(
    `insert into kb_sources (tenant_id, kind, status, name, url, domain, page_limit, attested_by,
                             attested_at, created_by, finished_at)
     values ($1, 'website', 'ready', 'kakibakery.sg', 'https://kakibakery.sg/', 'kakibakery.sg', 100, 'u', now(), 'u', now())
     returning id`,
    [tenantId],
  );
  await owner.query(
    `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
     values ($1, $2, 1, 0, 'https://kakibakery.sg/cakes', 'included', $3)`,
    [tenantId, rows[0].id, content],
  );
  return rows[0].id as string;
}

const status = async (id: string) =>
  (await owner.query(`select status, version from facts where id = $1`, [id])).rows[0];

describe('access (AC-8)', () => {
  it('needs kb.manage and a session', async () => {
    const id = await seed(asA, question('Delivery?'));
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', '/api/v1/kb/review/facts'],
      ['GET', '/api/v1/kb/review/summary'],
      ['GET', '/api/v1/kb/review/preview'],
      ['POST', '/api/v1/kb/review/approve-all', { previewHash: 'a'.repeat(64) }],
      ['POST', `/api/v1/kb/facts/${id}/approve`, { version: 1 }],
      ['POST', `/api/v1/kb/facts/${id}/reject`, { version: 1 }],
      ['POST', '/api/v1/kb/review/approve', { facts: [{ id, version: 1 }] }],
      ['POST', '/api/v1/kb/review/reject', { facts: [{ id, version: 1 }] }],
      ['POST', '/api/v1/kb/review/undo', { facts: [{ id, version: 2 }] }],
    ];
    for (const [method, url, body] of routes) {
      expect((await call(method, url, asAgent, body)).statusCode).toBe(403);
      expect((await call(method, url, '', body)).statusCode).toBe(401);
    }
    expect(await status(id)).toEqual({ status: 'needs_review', version: 1 });
  });

  it("keeps tenant B out of tenant A's facts", async () => {
    const id = await seed(asA, question('Delivery?'));
    expect((await call('GET', '/api/v1/kb/review/facts', asB)).json().facts).toEqual([]);
    expect((await call('GET', '/api/v1/kb/review/preview', asB)).json().count).toBe(0);
    for (const action of ['approve', 'reject']) {
      const res = await call('POST', `/api/v1/kb/facts/${id}/${action}`, asB, { version: 1 });
      expect(res.statusCode).toBe(404);
    }
    const bulk = await call('POST', '/api/v1/kb/review/approve', asB, {
      facts: [{ id, version: 1 }],
    });
    expect(bulk.json()).toEqual({ approved: [], skipped: [{ id, reason: 'not_found' }] });
    const bulkReject = await call('POST', '/api/v1/kb/review/reject', asB, {
      facts: [{ id, version: 1 }],
    });
    expect(bulkReject.json()).toEqual({ rejected: [], skipped: [{ id, reason: 'not_found' }] });
    const preview = (await call('GET', '/api/v1/kb/review/preview', asB)).json();
    await call('POST', '/api/v1/kb/review/approve-all', asB, {
      previewHash: preview.previewHash,
    });
    expect(await status(id)).toEqual({ status: 'needs_review', version: 1 });
    // A's decision can't be undone from B.
    await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, { version: 1 });
    const undo = await call('POST', '/api/v1/kb/review/undo', asB, { facts: [{ id, version: 2 }] });
    expect(undo.json()).toEqual({ restored: 0, skipped: [{ id, reason: 'not_found' }] });
    expect(await status(id)).toEqual({ status: 'approved', version: 2 });
  });
});

describe('the queue and summary (AC-2)', () => {
  it('lists facts to review in the KB-16 order with their passages', async () => {
    const page = 'Our Chocolate fudge cake — S$55.00 is our best seller.';
    const src = await seedSource(TENANT_A, page);
    const faq = await seed(asA, question('Delivery?'));
    const price = await seed(asA, cake('Chocolate fudge cake'), {
      sourceId: src,
      quote: 'Chocolate fudge cake — S$55.00',
    });
    const res = await call('GET', '/api/v1/kb/review/facts', asA);
    expect(res.statusCode).toBe(200);
    const { facts, nextCursor } = res.json();
    expect(facts.map((f: { id: string }) => f.id)).toEqual([price, faq]);
    expect(nextCursor).toBeNull();
    expect(facts[0]).toMatchObject({
      status: 'needs_review',
      confidence: 0.82,
      sourceName: 'kakibakery.sg',
      passage: {
        before: 'Our ',
        quote: 'Chocolate fudge cake — S$55.00',
        after: ' is our best seller.',
      },
    });
    expect(facts[0].sourceCapturedAt).toMatch(/^\d{4}-/);
    expect(facts[1]).toMatchObject({ passage: null, sourceName: null });

    const typed = await call('GET', '/api/v1/kb/review/facts?type=faq', asA);
    expect(typed.json().facts.map((f: { id: string }) => f.id)).toEqual([faq]);
    const bySource = await call('GET', `/api/v1/kb/review/facts?sourceId=${src}`, asA);
    expect(bySource.json().facts.map((f: { id: string }) => f.id)).toEqual([price]);
    const paged = await call('GET', '/api/v1/kb/review/facts?limit=1', asA);
    const next = await call(
      'GET',
      `/api/v1/kb/review/facts?limit=1&cursor=${paged.json().nextCursor}`,
      asA,
    );
    expect(next.json().facts.map((f: { id: string }) => f.id)).toEqual([faq]);

    for (const q of ['type=price', 'sourceId=nope', 'cursor=bm9wZQ', 'limit=500', 'q=x'])
      expect((await call('GET', `/api/v1/kb/review/facts?${q}`, asA)).statusCode).toBe(400);

    const summary = await call('GET', '/api/v1/kb/review/summary', asA);
    expect(summary.json()).toEqual({
      needsReview: 2,
      conflicted: 0,
      conflicts: 0, // FEAT-014, additive
      byType: { product: 1, policy: 0, promotion: 0, faq: 1 },
      bySource: [
        { id: src, name: 'kakibakery.sg', count: 1 },
        { id: null, name: null, count: 1 },
      ],
      approvedInUse: 0,
      sourcesBusy: 0,
    });
  });
});

describe('single decisions (AC-3)', () => {
  it('approves, and refuses a stale version and a decided fact', async () => {
    const id = await seed(asA, question('Delivery?'));
    expect(
      (await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, { version: 2 })).json(),
    ).toMatchObject({ error: 'version_conflict' });
    const ok = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, { version: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fact).toMatchObject({ id, status: 'approved', version: 2 });
    const again = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, { version: 2 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('invalid_state');
    expect((await call('POST', `/api/v1/kb/facts/not-a-uuid/approve`, asA, {})).statusCode).toBe(
      404,
    );
  });

  it('edits and approves, with the fields validated against the type', async () => {
    const id = await seed(asA, cake('Pandan chiffon', '28'));
    const bad = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, {
      version: 1,
      value: { name: 'Pandan chiffon', price: 'cheap' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, {
      version: 1,
      value: { name: 'Pandan chiffon cake', price: '30.00', unit: 'whole' },
      gstTreatment: 'exclusive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fact).toMatchObject({
      status: 'approved',
      version: 2,
      value: { name: 'Pandan chiffon cake', price: '30.00', unit: 'whole' },
      gstTreatment: 'exclusive',
    });
    const faq = await seed(asA, question('Halal?'));
    const wrong = await call('POST', `/api/v1/kb/facts/${faq}/approve`, asA, {
      version: 1,
      gstTreatment: 'inclusive',
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('asks for the GST choice on a GST-unknown price (KB-15)', async () => {
    const id = await seed(asA, cake('Cupcake box', '36'), { gstUnknown: true });
    const res = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'gst_required',
      message: 'Choose whether the price includes GST',
    });
    const ok = await call('POST', `/api/v1/kb/facts/${id}/approve`, asA, {
      version: 1,
      gstTreatment: 'inclusive',
    });
    expect(ok.json().fact).toMatchObject({ status: 'approved', gstTreatment: 'inclusive' });
  });

  it('rejects', async () => {
    const id = await seed(asA, question('Delivery?'));
    const res = await call('POST', `/api/v1/kb/facts/${id}/reject`, asA, { version: 1 });
    expect(res.json().fact).toMatchObject({ status: 'rejected', version: 2 });
    const again = await call('POST', `/api/v1/kb/facts/${id}/reject`, asA, { version: 2 });
    expect(again.json().error).toBe('invalid_state');
  });
});

describe('bulk, Approve all and undo (AC-4, AC-5, AC-6)', () => {
  it('approves a selection and reports the skipped ones', async () => {
    const a = await seed(asA, question('A?'));
    const b = await seed(asA, cake('B'), { gstUnknown: true });
    const res = await call('POST', '/api/v1/kb/review/approve', asA, {
      facts: [
        { id: a, version: 1 },
        { id: b, version: 1 },
      ],
    });
    expect(res.json()).toEqual({
      approved: [{ id: a, version: 2 }],
      skipped: [{ id: b, reason: 'gst_unknown' }],
    });
    const rej = await call('POST', '/api/v1/kb/review/reject', asA, {
      facts: [{ id: b, version: 1 }],
    });
    expect(rej.json()).toEqual({ rejected: [{ id: b, version: 2 }], skipped: [] });
    for (const facts of [
      [],
      [
        { id: a, version: 1 },
        { id: a, version: 1 },
      ],
      [{ id: 'x' }],
    ])
      expect((await call('POST', '/api/v1/kb/review/approve', asA, { facts })).statusCode).toBe(
        400,
      );
  });

  it('previews and approves all, and refuses a stale preview with a fresh one', async () => {
    const a = await seed(asA, cake('A'));
    const b = await seed(asA, question('B?'));
    const c = await seed(asA, cake('C'), { gstUnknown: true });
    const preview = (await call('GET', '/api/v1/kb/review/preview', asA)).json();
    expect(preview).toMatchObject({
      scope: {},
      count: 2,
      byType: { product: 1, policy: 0, promotion: 0, faq: 1 },
      excluded: { gstUnknown: 1, conflicted: 0 },
    });

    const late = await seed(asA, question('Late?'));
    const stale = await call('POST', '/api/v1/kb/review/approve-all', asA, {
      previewHash: preview.previewHash,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'preview_stale', preview: { count: 3 } });
    expect(await status(a)).toMatchObject({ status: 'needs_review' });

    const res = await call('POST', '/api/v1/kb/review/approve-all', asA, {
      previewHash: stale.json().preview.previewHash,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approved).toBe(3);
    expect(
      res
        .json()
        .facts.map((r: { id: string }) => r.id)
        .sort(),
    ).toEqual([a, b, late].sort());
    expect(await status(c)).toMatchObject({ status: 'needs_review' });

    const undo = await call('POST', '/api/v1/kb/review/undo', asA, { facts: res.json().facts });
    expect(undo.json()).toEqual({ restored: 3, skipped: [] });
    expect(await status(a)).toEqual({ status: 'needs_review', version: 3 });
    const bad = await call('POST', '/api/v1/kb/review/approve-all', asA, { previewHash: 'x' });
    expect(bad.statusCode).toBe(400);
  });

  it('scopes the preview and Approve all to one type', async () => {
    const a = await seed(asA, cake('A'));
    const b = await seed(asA, question('B?'));
    const preview = (await call('GET', '/api/v1/kb/review/preview?type=faq', asA)).json();
    expect(preview).toMatchObject({ scope: { type: 'faq' }, count: 1 });
    await call('POST', '/api/v1/kb/review/approve-all', asA, {
      type: 'faq',
      previewHash: preview.previewHash,
    });
    expect(await status(b)).toMatchObject({ status: 'approved' });
    expect(await status(a)).toMatchObject({ status: 'needs_review' });
  });
});
