/**
 * Conflict endpoints (FEAT-014 §3; AC-4..AC-9): the side-by-side list and each
 * resolution, with the designed errors. Detection itself is tested in kb.
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

const PAGE = 'Our cakes\nPandan chiffon cake (20 cm) — S$28.50\nBaked daily.';
const QUOTE = 'Pandan chiffon cake (20 cm) — S$28.50';

/**
 * Tenant A's conflict as promote leaves it: the owner's S$26.00 (confirmed yesterday)
 * and a website's S$28.50 with GST unknown, read today, both conflicted.
 */
async function seedConflict() {
  const res = await call('POST', '/api/v1/kb/facts', asA, {
    type: 'product',
    value: { name: 'Pandan chiffon cake', price: '26.00', unit: '20 cm' },
    gstTreatment: 'inclusive',
  });
  expect(res.statusCode).toBe(201);
  const typed = res.json().fact.id as string;
  const web = (
    await call('POST', '/api/v1/kb/facts', asA, {
      type: 'product',
      value: { name: 'Pandan chiffon cake', price: '28.50', unit: '20 cm' },
      gstTreatment: 'inclusive',
    })
  ).json().fact.id as string;
  const { rows } = await owner.query(
    `insert into kb_sources (tenant_id, kind, status, name, url, domain, page_limit, attested_by,
                             attested_at, created_by, finished_at)
     values ($1, 'website', 'ready', 'kakibakery.sg', 'https://kakibakery.sg/', 'kakibakery.sg', 100, 'u', now(), 'u', now())
     returning id`,
    [TENANT_A],
  );
  const src = rows[0].id as string;
  await owner.query(
    `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
     values ($1, $2, 1, 0, 'https://kakibakery.sg/cakes', 'included', $3)`,
    [TENANT_A, src, PAGE],
  );
  const start = PAGE.indexOf(QUOTE);
  await owner.query(
    `update facts set gst_treatment = 'unknown', source = 'website', source_id = $2, confidence = 0.9,
       provenance = $3 where id = $1`,
    [
      web,
      src,
      JSON.stringify({
        url: 'https://kakibakery.sg/cakes',
        title: 'Cakes',
        quote: QUOTE,
        start,
        end: start + QUOTE.length,
      }),
    ],
  );
  await owner.query(`update facts set last_confirmed_at = now() - interval '1 day' where id = $1`, [
    typed,
  ]);
  await owner.query(`update facts set status = 'conflicted', version = 2 where id in ($1, $2)`, [
    typed,
    web,
  ]);
  return {
    typed,
    web,
    refs: [
      { id: typed, version: 2 },
      { id: web, version: 2 },
    ],
  };
}

const statusOf = async (id: string) =>
  (await owner.query(`select status, version from facts where id = $1`, [id])).rows[0];

describe('access (AC-9)', () => {
  it('needs kb.manage and a session', async () => {
    const { typed, refs } = await seedConflict();
    const body = { action: 'use', facts: refs, keepId: typed };
    for (const [method, url, payload] of [
      ['GET', '/api/v1/kb/conflicts', undefined],
      ['POST', '/api/v1/kb/conflicts/resolve', body],
    ] as const) {
      expect((await call(method, url, asAgent, payload)).statusCode).toBe(403);
      expect((await call(method, url, '', payload)).statusCode).toBe(401);
    }
    expect(await statusOf(typed)).toEqual({ status: 'conflicted', version: 2 });
  });

  it("keeps tenant B out of tenant A's conflicts", async () => {
    const { typed, web, refs } = await seedConflict();
    expect((await call('GET', '/api/v1/kb/conflicts', asB)).json()).toEqual({ conflicts: [] });
    for (const body of [
      { action: 'use', facts: refs, keepId: typed },
      { action: 'use', facts: refs, keepId: web, gstTreatment: 'inclusive' },
      { action: 'enter', facts: refs, keepId: web, value: { name: 'X', price: '1.00' } },
      { action: 'disable', facts: refs, keepId: typed },
    ]) {
      const res = await call('POST', '/api/v1/kb/conflicts/resolve', asB, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'conflict_changed', conflict: null });
    }
    expect(await statusOf(typed)).toEqual({ status: 'conflicted', version: 2 });
    expect(await statusOf(web)).toEqual({ status: 'conflicted', version: 2 });
  });
});

describe('GET /api/v1/kb/conflicts (AC-4)', () => {
  it('lists each conflict with its sources side by side, the newer one suggested', async () => {
    const { typed, web } = await seedConflict();
    const res = await call('GET', '/api/v1/kb/conflicts', asA);
    expect(res.statusCode).toBe(200);
    const { conflicts } = res.json();
    expect(conflicts).toHaveLength(1);
    const [c] = conflicts;
    expect(c).toMatchObject({ type: 'product', suggestedId: web });
    expect(c.id).toMatch(/^[0-9a-f]{16}$/);
    expect(c.facts.map((m: { id: string }) => m.id)).toEqual([web, typed]);
    expect(c.facts[0]).toMatchObject({
      newer: true,
      sourceName: 'kakibakery.sg',
      gstTreatment: 'unknown',
      value: { price: '28.50' },
      passage: { before: 'Our cakes\n', quote: QUOTE, after: '\nBaked daily.' },
    });
    expect(c.facts[1]).toMatchObject({ newer: false, sourceName: null, passage: null });
    expect(Date.parse(c.facts[0].sourceDate)).toBeGreaterThan(Date.parse(c.facts[1].sourceDate));
    expect((await call('GET', '/api/v1/kb/review/summary', asA)).json()).toMatchObject({
      conflicted: 2,
      conflicts: 1,
    });
  });
});

describe('POST /api/v1/kb/conflicts/resolve (AC-5..AC-8)', () => {
  const resolve = (body: object) => call('POST', '/api/v1/kb/conflicts/resolve', asA, body);

  it('use keeps one value and rejects the rest', async () => {
    const { typed, web, refs } = await seedConflict();
    const res = await resolve({ action: 'use', facts: refs, keepId: typed });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      fact: { id: typed, status: 'approved', version: 3 },
      rejected: [{ id: web, version: 3 }],
    });
    expect((await call('GET', '/api/v1/kb/conflicts', asA)).json().conflicts).toEqual([]);
  });

  it('use on a GST-unknown price needs the choice, then approves with it', async () => {
    const { web, refs } = await seedConflict();
    const bad = await resolve({ action: 'use', facts: refs, keepId: web });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('gst_required');
    expect(await statusOf(web)).toEqual({ status: 'conflicted', version: 2 });
    const res = await resolve({
      action: 'use',
      facts: refs,
      keepId: web,
      gstTreatment: 'inclusive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fact).toMatchObject({
      id: web,
      status: 'approved',
      gstTreatment: 'inclusive',
      value: { price: '28.50' },
    });
  });

  it('enter stores the entered value; fields wrong for the type are 400', async () => {
    const { web, refs } = await seedConflict();
    for (const body of [
      { action: 'enter', facts: refs, keepId: web, value: { question: 'Q?', answer: 'A.' } },
      {
        action: 'enter',
        facts: refs,
        keepId: web,
        value: { name: 'Pandan chiffon cake', price: '27.00' },
        validUntil: '2026-12-31',
      },
    ]) {
      const res = await resolve(body);
      expect(res.statusCode).toBe(400);
    }
    expect(await statusOf(web)).toEqual({ status: 'conflicted', version: 2 });
    const res = await resolve({
      action: 'enter',
      facts: refs,
      keepId: web,
      value: { name: 'Pandan chiffon cake', price: '27.00', unit: '20 cm' },
      gstTreatment: 'inclusive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fact).toMatchObject({
      status: 'approved',
      gstTreatment: 'inclusive',
      value: { price: '27.00', unit: '20 cm' },
    });
  });

  it('disable keeps one fact disabled (UC-12 2a)', async () => {
    const { typed, web, refs } = await seedConflict();
    const res = await resolve({ action: 'disable', facts: refs, keepId: web });
    expect(res.statusCode).toBe(200);
    expect(res.json().fact).toMatchObject({ id: web, status: 'disabled' });
    expect(await statusOf(typed)).toMatchObject({ status: 'rejected' });
  });

  it('answers 409 conflict_changed with the fresh conflict, and 400 for a bad body', async () => {
    const { typed, refs } = await seedConflict();
    const stale = await resolve({
      action: 'use',
      facts: refs.map((r) => ({ ...r, version: 1 })),
      keepId: typed,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'conflict_changed',
      conflict: { suggestedId: refs[1]!.id },
    });
    const partial = await resolve({ action: 'use', facts: [refs[0]], keepId: typed });
    expect(partial.statusCode).toBe(409);
    for (const body of [
      { action: 'use', facts: refs, keepId: '00000000-0000-4000-8000-000000000999' },
      { action: 'use', facts: [], keepId: typed },
      { action: 'keep', facts: refs, keepId: typed },
      { action: 'use', facts: [refs[0], refs[0]], keepId: typed },
      { action: 'disable', facts: refs, keepId: typed, gstTreatment: 'inclusive' },
    ])
      expect((await resolve(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect(await statusOf(typed)).toEqual({ status: 'conflicted', version: 2 });
  });
});
