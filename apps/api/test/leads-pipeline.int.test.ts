/**
 * FEAT-050 routes (§3, §5.5; AC-4, AC-5, AC-7, AC-9): the leads list, lead page, status changes
 * (Owner/Admin, compare-and-set) and the CSV export (re-auth, audit, headers), the settings'
 * qualification with its rescore count, and tenant isolation.
 */
import { LeadConflict409, LeadDetail, LeadList, ReauthRequired } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import { leadCaptureConfig, submitContactForm } from '@kaki/leads';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let ownerId: string;
let asA: string;
let asAgent: string;
let asB: string;
const leadIds: string[] = [];

const FIELDS = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'optional' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'optional' },
  { key: 'preferredTime', mode: 'optional' },
];

const call = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  const u = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');

  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: ownerId,
      version: 0,
      purpose: { en: 'To reply to you.', zh: null },
    }),
  );
  const saved = await call('PUT', '/api/v1/settings/leads', asA, {
    version: 0,
    fields: FIELDS,
    marketing: { enabled: false, text: { en: '', zh: null } },
    qualification: { keywords: ['wedding'], minBudget: 300 },
  });
  expect(saved.statusCode).toBe(200);
  // Two contact-form leads: one warm (keyword + need), one cold.
  for (const [email, need] of [
    ['first@example.com', 'Wedding cake'],
    ['second@example.com', '=HYPERLINK("x")'],
  ] as const) {
    const out = await withTenant(tdb.zone('visitor'), TENANT_A, async (tx) => {
      const config = (await leadCaptureConfig(tx))!;
      return submitContactForm(tx, {
        tenantId: TENANT_A,
        conversationId: null,
        purposeWordingId: config.purpose.wordingId,
        input: { name: 'Mei', email, phone: '', need, budget: '', preferredTime: '' },
      });
    });
    leadIds.push(out.leadId);
  }
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('leads list and lead page (AC-4, AC-9)', () => {
  it('everyone with inbox.read lists and opens leads; tenant B sees none', async () => {
    const res = await call('GET', '/api/v1/leads?status=open&limit=10', asAgent);
    expect(res.statusCode).toBe(200);
    const list = LeadList.parse(res.json());
    expect(list.items.map((i) => i.id)).toEqual([leadIds[1], leadIds[0]]);
    expect(list.items[1]).toMatchObject({ source: 'contact_form', scoring: { score: 'warm' } });
    expect(list.counts).toMatchObject({ new: 2 });

    const one = await call('GET', `/api/v1/leads/${leadIds[0]}`, asAgent);
    expect(one.statusCode).toBe(200);
    expect(LeadDetail.parse(one.json())).toMatchObject({
      need: 'Wedding cake',
      canManage: false,
      canExport: false,
      consents: [{ purpose: 'enquiry', decision: 'agreed', wording: { text: 'To reply to you.' } }],
    });
    expect((await call('GET', `/api/v1/leads/${leadIds[0]}`, asA)).json()).toMatchObject({
      canManage: true,
      canExport: true,
    });

    expect((await call('GET', `/api/v1/leads/${leadIds[0]}`, asB)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/leads/not-a-uuid', asA)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/leads?status=all', asB)).json()).toMatchObject({
      items: [],
      counts: { new: 0, contacted: 0, won: 0, lost: 0 },
    });
    expect((await call('GET', '/api/v1/leads?limit=500', asA)).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/leads?cursor=bogus', asA)).statusCode).toBe(400);
  });
});

describe('status changes (AC-4)', () => {
  it('Owner moves with compare-and-set; stale is 409 with the row; Agent and tenant B refused', async () => {
    const url = `/api/v1/leads/${leadIds[1]}/status`;
    expect((await call('POST', url, asAgent, { status: 'contacted', version: 1 })).statusCode).toBe(
      403,
    );
    const ok = await call('POST', url, asA, { status: 'contacted', version: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'contacted', version: 2 });
    const stale = await call('POST', url, asA, { status: 'won', version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(LeadConflict409.parse(stale.json())).toMatchObject({
      error: 'stale',
      lead: { status: 'contacted', version: 2 },
    });
    expect((await call('POST', url, asB, { status: 'won', version: 2 })).statusCode).toBe(404);
    expect((await call('POST', url, asA, { status: 'won', version: 2, x: 1 })).statusCode).toBe(
      400,
    );
  });
});

describe('CSV export (AC-5, AC-7)', () => {
  it('needs leads.export and a fresh re-auth; audits the count and filters only', async () => {
    expect(
      (await call('POST', '/api/v1/leads/export', asAgent, { status: 'all' })).statusCode,
    ).toBe(403);
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [ownerId],
    );
    const refused = await call('POST', '/api/v1/leads/export', asA, { status: 'all' });
    expect(refused.statusCode).toBe(403);
    expect(ReauthRequired.parse(refused.json()).error).toBe('reauth_required');
    const audited = async () =>
      (
        await owner.query<{ n: number }>(
          `select count(*)::int n from audit_entries where tenant_id = $1 and event_type = 'lead.exported'`,
          [TENANT_A],
        )
      ).rows[0]!.n;
    expect(await audited()).toBe(0);

    await owner.query(`update sessions set reauth_at = now() where user_id = $1`, [ownerId]);
    const res = await call('POST', '/api/v1/leads/export', asA, { status: 'all' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toMatch(/^"Reminder: the Do Not Call Registry applies/);
    expect(lines[1]).toMatch(/^Created \(SGT\),Updated \(SGT\),Status,Score/);
    expect(lines.filter((l) => l.length > 0)).toHaveLength(4);
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(await audited()).toBe(1);
    const entry = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'lead.exported'`,
      [TENANT_A],
    );
    expect(entry.rows[0].payload).toEqual({ count: 2, status: 'all' });

    // Tenant B exports an empty file of its own.
    const b = await call('POST', '/api/v1/leads/export', asB, {});
    expect(b.statusCode).toBe(200);
    expect(b.body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
    expect(
      (await call('POST', '/api/v1/leads/export', asA, { status: 'all', email: 'x' })).statusCode,
    ).toBe(400);
  });
});

describe('qualification on lead settings (AC-1)', () => {
  it('a changed qualification returns how many open leads were rescored', async () => {
    const current = (await call('GET', '/api/v1/settings/leads', asA)).json();
    expect(current.qualification).toEqual({ keywords: ['wedding'], minBudget: 300 });
    const res = await call('PUT', '/api/v1/settings/leads', asA, {
      version: current.version,
      fields: FIELDS,
      marketing: { enabled: false, text: { en: '', zh: null } },
      qualification: { keywords: ['wedding', 'hyperlink'], minBudget: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rescored: 2,
      qualification: { keywords: ['wedding', 'hyperlink'] },
    });
    const bad = await call('PUT', '/api/v1/settings/leads', asA, {
      version: current.version + 1,
      fields: FIELDS,
      marketing: { enabled: false, text: { en: '', zh: null } },
      qualification: { keywords: ['a', 'A'], minBudget: null },
    });
    expect(bad.statusCode).toBe(400);
  });
});
