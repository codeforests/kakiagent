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
  // A staff member (role agent) of tenant A, for the permission checks.
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

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const cake = {
  type: 'product',
  value: { name: 'Eggless chocolate cake', price: '55', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

describe('fact endpoints (AC-11)', () => {
  it('creates an approved fact with its version, chunk and audit entry', async () => {
    const res = await call('POST', '/api/v1/kb/facts', asA, cake);
    expect(res.statusCode).toBe(201);
    const { fact } = res.json();
    expect(fact).toMatchObject({
      type: 'product',
      status: 'approved',
      version: 1,
      source: 'manual',
      gstTreatment: 'inclusive',
      value: { name: 'Eggless chocolate cake', price: '55.00', unit: '1 kg' },
    });
    const versions = await owner.query(`select version from fact_versions where fact_id = $1`, [
      fact.id,
    ]);
    expect(versions.rows).toEqual([{ version: 1 }]);
    const chunks = await owner.query(`select fact_version from kb_chunks where fact_id = $1`, [
      fact.id,
    ]);
    expect(chunks.rows).toEqual([{ fact_version: 1 }]);
    const audit = await owner.query(
      `select event_type as action from audit_entries where split_part(subject_refs[1], ':', 2) = $1`,
      [fact.id],
    );
    expect(audit.rows).toEqual([{ action: 'fact.created' }]);
    const stored = await owner.query(`select value from facts where id = $1`, [fact.id]);
    expect(stored.rows[0].value).toMatchObject({ priceCents: 5500, currency: 'SGD' });
  });

  it.each([
    ['a product without a price', { ...cake, value: { name: 'Cake' } }],
    ['a product without a GST treatment', { type: 'product', value: cake.value }],
    ['a price with three decimals', { ...cake, value: { ...cake.value, price: '55.123' } }],
    [
      'an FAQ with a GST treatment',
      { type: 'faq', value: { question: 'Halal?', answer: 'Yes.' }, gstTreatment: 'inclusive' },
    ],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await call('POST', '/api/v1/kb/facts', asA, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('edits with optimistic concurrency and answers a stale version with 409', async () => {
    const { fact } = (await call('POST', '/api/v1/kb/facts', asA, cake)).json();
    const edit = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, {
      version: 1,
      value: { name: 'Eggless chocolate cake', price: '58.50' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().fact).toMatchObject({ version: 2, value: { price: '58.50' } });
    expect(edit.json().fact.value.unit).toBeUndefined();

    const stale = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, {
      version: 1,
      status: 'disabled',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'version_conflict' });

    const disable = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, {
      version: 2,
      status: 'disabled',
    });
    expect(disable.json().fact).toMatchObject({ status: 'disabled', version: 3 });
  });

  it('rejects a GST treatment on an FAQ edit and an empty patch', async () => {
    const { fact } = (
      await call('POST', '/api/v1/kb/facts', asA, {
        type: 'faq',
        value: { question: 'Do you deliver?', answer: 'Yes, islandwide.' },
      })
    ).json();
    expect(fact.gstTreatment).toBeNull();
    const gst = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, {
      version: 1,
      gstTreatment: 'exclusive',
    });
    expect(gst.statusCode).toBe(400);
    const empty = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, { version: 1 });
    expect(empty.statusCode).toBe(400);
  });

  it('answers an edit of a rejected fact with 409 invalid_state', async () => {
    const { fact } = (await call('POST', '/api/v1/kb/facts', asA, cake)).json();
    await owner.query(`update facts set status = 'rejected' where id = $1`, [fact.id]);
    const res = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asA, {
      version: 1,
      value: { name: 'Cake', price: '1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'invalid_state' });
  });

  it('forbids a session without kb.manage', async () => {
    expect((await call('GET', '/api/v1/kb/facts', asAgent)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/kb/facts', asAgent, cake)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/kb/facts', '')).statusCode).toBe(401);
  });

  it("hides another tenant's facts", async () => {
    const { fact } = (await call('POST', '/api/v1/kb/facts', asA, cake)).json();
    expect((await call('GET', `/api/v1/kb/facts/${fact.id}`, asB)).statusCode).toBe(404);
    const patch = await call('PATCH', `/api/v1/kb/facts/${fact.id}`, asB, {
      version: 1,
      status: 'disabled',
    });
    expect(patch.statusCode).toBe(404);
    expect((await call('GET', '/api/v1/kb/facts/not-a-uuid', asA)).statusCode).toBe(404);
    const listB = (await call('GET', '/api/v1/kb/facts', asB)).json();
    expect(listB.facts.map((f: { id: string }) => f.id)).not.toContain(fact.id);
  });

  it('filters the list by status and text', async () => {
    const { fact } = (
      await call('POST', '/api/v1/kb/facts', asA, {
        type: 'faq',
        value: {
          question: 'Is the pandan chiffon halal?',
          answer: 'Our kitchen is halal-certified.',
        },
      })
    ).json();
    const byText = (await call('GET', '/api/v1/kb/facts?q=pandan', asA)).json();
    expect(byText.facts.map((f: { id: string }) => f.id)).toEqual([fact.id]);
    const disabled = (await call('GET', '/api/v1/kb/facts?status=disabled', asA)).json();
    expect(disabled.facts.every((f: { status: string }) => f.status === 'disabled')).toBe(true);
    expect((await call('GET', '/api/v1/kb/facts?status=bogus', asA)).statusCode).toBe(400);
  });
});
