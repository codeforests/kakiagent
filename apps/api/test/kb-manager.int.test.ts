/**
 * KB manager endpoints (FEAT-011 §3; AC-1, AC-2, AC-4, AC-7): list filters and
 * paging, DELETE, policy and promotion facts, GST-unknown review.
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  payload?: unknown,
) => app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const policy = {
  type: 'policy',
  value: {
    kind: 'refund',
    title: 'Refunds on whole cakes',
    details: 'Cancel at least two days before collection for a full refund.',
  },
};
const promotion = {
  type: 'promotion',
  value: { title: 'Deepavali kueh bundle', details: 'Any two boxes of kueh.', price: '20' },
  gstTreatment: 'exclusive',
  validFrom: '2026-10-20',
  validUntil: '2099-10-31',
};

const create = async (body: unknown, who = asA) => {
  const res = await call('POST', '/api/v1/kb/facts', who, body);
  expect(res.statusCode).toBe(201);
  return res.json().fact;
};

describe('policies and promotions (AC-4)', () => {
  it('creates a policy and a promotion with their validity days round-tripped', async () => {
    expect(await create(policy)).toMatchObject({
      type: 'policy',
      status: 'approved',
      version: 1,
      gstTreatment: null,
      validFrom: null,
      validUntil: null,
      value: policy.value,
    });
    const promo = await create(promotion);
    expect(promo).toMatchObject({
      type: 'promotion',
      gstTreatment: 'exclusive',
      validFrom: '2026-10-20',
      validUntil: '2099-10-31',
      value: { title: 'Deepavali kueh bundle', price: '20.00' },
    });
    const stored = await owner.query(
      `select valid_from, valid_until, value from facts where id = $1`,
      [promo.id],
    );
    expect(stored.rows[0].valid_from.toISOString()).toBe('2026-10-19T16:00:00.000Z');
    expect(stored.rows[0].valid_until.toISOString()).toBe('2099-10-31T16:00:00.000Z');
    expect(stored.rows[0].value).toMatchObject({ priceCents: 2000, currency: 'SGD' });
    const unpriced = await create({
      type: 'promotion',
      value: { title: 'Free candle', details: 'With every birthday cake.' },
      validUntil: '2099-01-01',
    });
    expect(unpriced).toMatchObject({ gstTreatment: null, validFrom: null });
    expect(unpriced.value.price).toBeUndefined();
  });

  it.each([
    ['a policy with a GST treatment', { ...policy, gstTreatment: 'inclusive' }],
    ['an unknown policy kind', { ...policy, value: { ...policy.value, kind: 'warranty' } }],
    ['a promotion without an end date', { ...promotion, validUntil: undefined }],
    ['a start after the end', { ...promotion, validFrom: '2099-11-01' }],
    ['a promotion price without GST', { ...promotion, gstTreatment: undefined }],
    [
      'a GST treatment without a promotion price',
      { ...promotion, value: { title: 't', details: 'd' } },
    ],
    [
      'validity on a product',
      {
        type: 'product',
        value: { name: 'Cake', price: '5' },
        gstTreatment: 'inclusive',
        validUntil: '2099-01-01',
      },
    ],
    [
      'validity on an FAQ',
      { type: 'faq', value: { question: 'q', answer: 'a' }, validUntil: '2099-01-01' },
    ],
    ['validity on a policy', { ...policy, validUntil: '2099-01-01' }],
    ['a date that does not exist', { ...promotion, validUntil: '2026-02-30' }],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await call('POST', '/api/v1/kb/facts', asA, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('edits a promotion: price and GST together, validity days, start cleared', async () => {
    const promo = await create(promotion);
    const noPrice = await call('PATCH', `/api/v1/kb/facts/${promo.id}`, asA, {
      version: 1,
      value: { title: 'Deepavali kueh bundle', details: 'Free box with two boxes.' },
    });
    expect(noPrice.statusCode).toBe(200);
    expect(noPrice.json().fact).toMatchObject({ version: 2, gstTreatment: null });
    const priceNoGst = await call('PATCH', `/api/v1/kb/facts/${promo.id}`, asA, {
      version: 2,
      value: { title: 'Deepavali kueh bundle', details: 'Two boxes.', price: '18' },
    });
    expect(priceNoGst.statusCode).toBe(400);
    const dates = await call('PATCH', `/api/v1/kb/facts/${promo.id}`, asA, {
      version: 2,
      validFrom: null,
      validUntil: '2099-12-31',
    });
    expect(dates.json().fact).toMatchObject({
      version: 3,
      validFrom: null,
      validUntil: '2099-12-31',
    });
    const bad = await call('PATCH', `/api/v1/kb/facts/${promo.id}`, asA, {
      version: 3,
      validFrom: '2100-01-05',
    });
    expect(bad.statusCode).toBe(400);
    const p = await create(policy);
    const onPolicy = await call('PATCH', `/api/v1/kb/facts/${p.id}`, asA, {
      version: 1,
      validUntil: '2099-01-01',
    });
    expect(onPolicy.statusCode).toBe(400);
    const policyEdit = await call('PATCH', `/api/v1/kb/facts/${p.id}`, asA, {
      version: 1,
      value: { ...policy.value, kind: 'booking' },
    });
    expect(policyEdit.json().fact.value.kind).toBe('booking');
  });
});

describe('list filters and paging (AC-1)', () => {
  it('filters by type, GST and text, and pages with nextCursor', async () => {
    for (let i = 0; i < 5; i++)
      await create(
        { type: 'faq', value: { question: `Paging question ${i}?`, answer: 'Yes.' } },
        asB,
      );
    const seen: string[] = [];
    let url = '/api/v1/kb/facts?q=Paging&limit=2';
    for (;;) {
      const page = (await call('GET', url, asB)).json();
      seen.push(...page.facts.map((f: { id: string }) => f.id));
      if (!page.nextCursor) break;
      url = `/api/v1/kb/facts?q=Paging&limit=2&cursor=${page.nextCursor}`;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const def = (await call('GET', '/api/v1/kb/facts', asB)).json();
    expect(def.nextCursor).toBeNull();

    await create(policy, asB);
    const types = (await call('GET', '/api/v1/kb/facts?type=policy', asB)).json();
    expect(types.facts.map((f: { type: string }) => f.type)).toEqual(['policy']);
    const byDetails = (await call('GET', '/api/v1/kb/facts?q=collection', asB)).json();
    expect(byDetails.facts.map((f: { type: string }) => f.type)).toEqual(['policy']);
    for (const bad of ['limit=0', 'limit=201', 'cursor=nonsense', 'type=service', 'gst=inclusive'])
      expect((await call('GET', `/api/v1/kb/facts?${bad}`, asB)).statusCode).toBe(400);
  });

  it('lists GST-unknown prices for review, and a chosen treatment makes them quotable (AC-7)', async () => {
    const { rows } = await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment, source)
       values ($1, 'product', 'approved', $2, 'unknown', 'website') returning id`,
      [TENANT_A, { name: 'Ondeh ondeh box', priceCents: 1800, currency: 'SGD' }],
    );
    const id = rows[0].id as string;
    await owner.query(
      `insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment)
       select tenant_id, id, version, status, value, gst_treatment from facts where id = $1`,
      [id],
    );
    const flagged = (await call('GET', '/api/v1/kb/facts?gst=unknown', asA)).json();
    expect(flagged.facts.map((f: { id: string }) => f.id)).toEqual([id]);
    expect(flagged.facts[0].gstTreatment).toBe('unknown');
    const set = await call('PATCH', `/api/v1/kb/facts/${id}`, asA, {
      version: 1,
      gstTreatment: 'inclusive',
    });
    expect(set.json().fact).toMatchObject({ gstTreatment: 'inclusive', version: 2 });
    expect((await call('GET', '/api/v1/kb/facts?gst=unknown', asA)).json().facts).toEqual([]);
  });
});

describe('DELETE /api/v1/kb/facts/:id (AC-2)', () => {
  it('deletes with the current version: 204, then 404', async () => {
    const fact = await create(policy);
    const url = `/api/v1/kb/facts/${fact.id}`;
    expect((await call('DELETE', url, asA)).statusCode).toBe(400);
    expect((await call('DELETE', `${url}?version=0`, asA)).statusCode).toBe(400);
    await call('PATCH', url, asA, { version: 1, status: 'disabled' });
    const stale = await call('DELETE', `${url}?version=1`, asA);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'version_conflict' });
    expect((await call('GET', url, asA)).statusCode).toBe(200);

    const res = await call('DELETE', `${url}?version=2`, asA);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await call('GET', url, asA)).statusCode).toBe(404);
    expect((await call('DELETE', `${url}?version=2`, asA)).statusCode).toBe(404);
    const audit = await owner.query(
      `select event_type, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq desc limit 1`,
      [fact.id],
    );
    expect(audit.rows[0]).toEqual({
      event_type: 'fact.deleted',
      payload: { type: 'policy', version: 2 },
    });
  });

  it("refuses another tenant's fact, a malformed ID and a staff session", async () => {
    const fact = await create(policy);
    expect((await call('DELETE', `/api/v1/kb/facts/${fact.id}?version=1`, asB)).statusCode).toBe(
      404,
    );
    expect(
      (await call('DELETE', `/api/v1/kb/facts/${fact.id}?version=1`, asAgent)).statusCode,
    ).toBe(403);
    expect((await call('DELETE', '/api/v1/kb/facts/nope?version=1', asA)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/kb/facts/${fact.id}`, asA)).statusCode).toBe(200);
  });
});
