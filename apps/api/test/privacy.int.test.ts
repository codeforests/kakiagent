/**
 * Privacy and data endpoints (FEAT-058 §3; AC-1, AC-2, AC-4, AC-5, AC-7, AC-8): settings,
 * PDFs, the hosted notice and the widget config's privacy link.
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;
let keyB: string;

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
  keyB = (await owner.query(`select widget_key from tenants where id = $1`, [TENANT_B])).rows[0]
    .widget_key;
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from privacy_settings`);
  await owner.query(`delete from wording_versions`);
});

const BASE = '/api/v1/settings/privacy';
const call = (method: 'GET' | 'PUT', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });
const config = () =>
  app.inject({
    method: 'GET',
    url: '/widget/v1/config?key=wk_dev_bakery',
    headers: { origin: 'http://localhost:5175' },
  });
const FIELDS = {
  contactName: 'Mei <b>Lin</b>',
  contactEmail: 'dpo@kakibakery.test',
  contactPhone: null,
  address: null,
  extra: '<script>alert(1)</script>',
};
const LINK = 'https://kakibakery.test/privacy';

describe('privacy settings (FEAT-058)', () => {
  it('returns defaults for a tenant that saved nothing', async () => {
    const res = await call('GET', BASE, asA);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      version: 0,
      notice: { mode: 'none' },
      purpose: { wording: null },
      readiness: { privacyNotice: false, purposeStatement: false },
      defaults: { template: { organisationName: expect.any(String) } },
    });
    expect(body.documents.subProcessors.length).toBeGreaterThan(0);
    expect(body.documents.transfers.length).toBeGreaterThan(0);
    expect(body.terms.map((t: { document: string }) => t.document)).toEqual(['tos', 'aup', 'dpa']);
    expect(body.terms[0].acceptedVersion).toEqual(expect.any(String));
    expect((await config()).json().privacyNoticeUrl).toBeNull();
  });

  it('saves a link; the widget config returns it', async () => {
    const res = await call('PUT', `${BASE}/notice`, asA, { version: 0, mode: 'link', url: LINK });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 1,
      notice: { mode: 'link', url: LINK, wording: { seq: 1 } },
      readiness: { privacyNotice: true, purposeStatement: false },
    });
    expect((await config()).json().privacyNoticeUrl).toBe(LINK);
  });

  it('rejects http and javascript: links', async () => {
    for (const url of ['http://kakibakery.test/privacy', 'javascript:alert(1)'])
      expect(
        (await call('PUT', `${BASE}/notice`, asA, { version: 0, mode: 'link', url })).statusCode,
      ).toBe(400);
  });

  it('saves the template; the hosted page is escaped, strict and not indexed', async () => {
    const res = await call('PUT', `${BASE}/notice`, asA, {
      version: 0,
      mode: 'template',
      fields: FIELDS,
    });
    expect(res.statusCode).toBe(200);
    const publicUrl = 'http://localhost:3000/privacy/wk_dev_bakery';
    expect(res.json().notice).toMatchObject({ mode: 'template', publicUrl });
    expect((await config()).json().privacyNoticeUrl).toBe(publicUrl);

    const page = await app.inject({ method: 'GET', url: '/privacy/wk_dev_bakery' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.body).toContain('Mei &lt;b&gt;Lin&lt;/b&gt;, dpo@kakibakery.test');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>');
    // AC-2: the business name and the purpose statement (the default until one is saved).
    const { name } = (await owner.query(`select name from tenants where id = $1`, [TENANT_A]))
      .rows[0];
    expect(page.body).toContain(name);
    expect(page.body).toContain('to reply to your enquiry and follow up about it');
    expect(page.body).toContain('Sydney / Melbourne');
    expect(page.body).toMatch(/Last updated \d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(page.body).toContain('--space-4'); // the token stylesheet
  });

  it('serves the 404 page for an unknown key, a link-mode tenant and a suspended tenant', async () => {
    const get = (key: string) => app.inject({ method: 'GET', url: `/privacy/${key}` });
    expect((await get('wk_nope')).statusCode).toBe(404);
    expect((await get('wk_nope')).body).toContain('This privacy notice isn’t available');
    await call('PUT', `${BASE}/notice`, asA, { version: 0, mode: 'link', url: LINK });
    expect((await get('wk_dev_bakery')).statusCode).toBe(404);
    await call('PUT', `${BASE}/notice`, asB, { version: 0, mode: 'template', fields: FIELDS });
    expect((await get(keyB)).statusCode).toBe(200);
    await owner.query(`update tenants set status = 'suspended' where id = $1`, [TENANT_B]);
    try {
      expect((await get(keyB)).statusCode).toBe(404);
    } finally {
      await owner.query(`update tenants set status = 'active' where id = $1`, [TENANT_B]);
    }
  });

  it('a stale version is 409 and adds no wording', async () => {
    await call('PUT', `${BASE}/notice`, asA, { version: 0, mode: 'link', url: LINK });
    const res = await call('PUT', `${BASE}/purpose`, asA, {
      version: 0,
      purpose: { en: 'To reply.', zh: null },
    });
    expect(res.statusCode).toBe(409);
    expect((await owner.query(`select count(*)::int as n from wording_versions`)).rows[0].n).toBe(
      1,
    );
    const ok = await call('PUT', `${BASE}/purpose`, asA, {
      version: 1,
      purpose: { en: 'To reply.', zh: '为了回复。' },
    });
    expect(ok.json()).toMatchObject({
      version: 2,
      purpose: { text: { en: 'To reply.', zh: '为了回复。' }, wording: { seq: 1 } },
      readiness: { privacyNotice: true, purposeStatement: true },
    });
  });

  it('serves both PDFs as attachments; unknown documents are 404', async () => {
    for (const doc of ['data-flow', 'dpa']) {
      const res = await call('GET', `${BASE}/documents/${doc}.pdf`, asA);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(
        new RegExp(`^attachment; filename="kakiagent-${doc}-\\d{4}-\\d{2}-\\d{2}\\.pdf"$`),
      );
      expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
    expect((await call('GET', `${BASE}/documents/terms.pdf`, asA)).statusCode).toBe(404);
  });

  it('an Agent gets 403 on every dashboard route', async () => {
    for (const [method, url, payload] of [
      ['GET', BASE],
      ['PUT', `${BASE}/notice`, { version: 0, mode: 'link', url: LINK }],
      ['PUT', `${BASE}/purpose`, { version: 0, purpose: { en: 'x', zh: null } }],
      ['GET', `${BASE}/documents/dpa.pdf`],
    ] as const)
      expect((await call(method, url, asAgent, payload)).statusCode).toBe(403);
  });

  it("tenant B's session never sees tenant A's settings", async () => {
    await call('PUT', `${BASE}/notice`, asA, { version: 0, mode: 'link', url: LINK });
    const b = (await call('GET', BASE, asB)).json();
    expect(b).toMatchObject({ version: 0, notice: { mode: 'none' } });
  });
});
