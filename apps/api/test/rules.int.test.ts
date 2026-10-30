/**
 * Boundary rules settings (APR-01, UC-29, AUTH-03; FEAT-054 §3, §5.4; AC-1, AC-2, AC-3,
 * AC-4, AC-10): read with the template prefill, save behind a fresh re-auth, the stale
 * check, field errors, one code-only audit entry per save, and tenant isolation.
 */
import { BoundaryRulesResponse, ReauthRequired } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asAdmin: string;
let asAgent: string;
let asB: string;
let ownerA: string;

const SAFE = {
  allowedTopics: [],
  blockedTopics: [],
  maxDiscountPct: 0,
  quotesNeedApproval: true,
  forbiddenCommitments: ['delivery_guarantee', 'refund', 'legal_advice', 'medical_advice'],
  customCommitments: [],
};
const RULES = {
  allowedTopics: ['Menu and prices', 'Cakes'],
  blockedTopics: ['Politics'],
  maxDiscountPct: 10,
  quotesNeedApproval: false,
  forbiddenCommitments: ['refund', 'legal_advice', 'medical_advice'],
  customCommitments: ['same-day delivery'],
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (const [email, role] of [
    ['admin@kaki-bakery.test', 'admin'],
    ['staff@kaki-bakery.test', 'agent'],
  ]) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email) values ($1) returning id`,
      [email],
    );
    await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
      TENANT_A,
      u.rows[0]!.id,
      role,
    ]);
  }
  ownerA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAdmin = await sessionCookie(tdb, 'admin@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from boundary_rules`);
  await owner.query(`update sessions set reauth_at = now()`);
});

const get = (who: string) =>
  app.inject({ method: 'GET', url: '/api/v1/settings/rules', headers: { cookie: who } });
const put = (who: string, body: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1/settings/rules',
    headers: { cookie: who },
    payload: body,
  });
const rulesEntries = async (tenantId = TENANT_A) =>
  (
    await owner.query(
      `select actor_type, actor_ref, payload::text as p from audit_entries
       where tenant_id = $1 and event_type = 'rules.updated' order by seq`,
      [tenantId],
    )
  ).rows;
const versions = async () =>
  Number((await owner.query(`select count(*) from boundary_rules`)).rows[0].count);

describe('boundary rules routes (FEAT-054)', () => {
  it('shows the F&B template over the safe defaults before any save, else the defaults (AC-1)', async () => {
    const a = BoundaryRulesResponse.parse((await get(asA)).json());
    expect(a).toMatchObject({ version: null, savedAt: null, source: 'template' });
    expect(a.rules.allowedTopics).toContain('Menu and prices');
    expect(a.rules.blockedTopics).toContain("Competitors' prices");
    expect({ ...a.rules, allowedTopics: [], blockedTopics: [] }).toEqual(SAFE);
    const industryB = (
      await owner.query(`select industry from business_profiles where tenant_id = $1`, [TENANT_B])
    ).rows[0]?.industry;
    const b = BoundaryRulesResponse.parse((await get(asB)).json());
    if (industryB === 'fnb') expect(b.source).toBe('template');
    else expect(b).toMatchObject({ source: 'default', rules: SAFE });
  });

  it('Owner and Admin save; the response and a reload return the new version (AC-2, AC-4)', async () => {
    const before = (await rulesEntries()).length;
    const first = await put(asA, { version: null, rules: RULES });
    expect(first.statusCode).toBe(200);
    expect(BoundaryRulesResponse.parse(first.json())).toMatchObject({
      version: 1,
      source: 'saved',
      rules: RULES,
    });
    const second = await put(asAdmin, { version: 1, rules: { ...RULES, maxDiscountPct: 5 } });
    expect(second.json()).toMatchObject({ version: 2, rules: { maxDiscountPct: 5 } });
    expect((await get(asA)).json()).toMatchObject({ version: 2, source: 'saved' });

    const entries = (await rulesEntries()).slice(before);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ actor_type: 'user', actor_ref: ownerA });
    expect(JSON.parse(entries[0].p)).toEqual({
      version: 1,
      changed: [
        'allowed_topics',
        'blocked_topics',
        'max_discount',
        'quotes_need_approval',
        'forbidden_commitments',
        'custom_commitments',
      ],
    });
    expect(JSON.parse(entries[1].p)).toEqual({ version: 2, changed: ['max_discount'] });
    expect(entries.map((e) => e.p).join()).not.toMatch(/Politics|Cakes|same-day/);
  });

  it('refuses a stale re-auth with 403 and writes nothing (AC-3)', async () => {
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [ownerA],
    );
    const before = (await rulesEntries()).length;
    const res = await put(asA, { version: null, rules: RULES });
    expect(res.statusCode).toBe(403);
    expect(ReauthRequired.parse(res.json()).error).toBe('reauth_required');
    expect(await versions()).toBe(0);
    expect((await rulesEntries()).length).toBe(before);
  });

  it('refuses a stale version with 409 rules_stale (AC-4)', async () => {
    expect((await put(asA, { version: null, rules: RULES })).statusCode).toBe(200);
    const stale = await put(asAdmin, { version: null, rules: SAFE });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('rules_stale');
    expect((await put(asAdmin, { version: 7, rules: SAFE })).statusCode).toBe(409);
    expect(await versions()).toBe(1);
  });

  it('refuses invalid rules with 400 and the field paths, before asking for re-auth (AC-2, D7)', async () => {
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [ownerA],
    );
    const fields = async (rules: unknown) => {
      const res = await put(asA, { version: null, rules });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_rules');
      return res.json().fields;
    };
    expect(await fields({ ...RULES, blockedTopics: ['Politics', 'politics'] })).toEqual({
      'rules.blockedTopics.1': 'duplicate',
    });
    expect(await fields({ ...RULES, blockedTopics: ['cakes'] })).toEqual({
      'rules.blockedTopics.0': 'also_allowed',
    });
    expect(await fields({ ...RULES, forbiddenCommitments: ['refund'] })).toEqual({
      'rules.forbiddenCommitments': 'locked',
    });
    expect(await fields({ ...RULES, maxDiscountPct: 101 })).toEqual({
      'rules.maxDiscountPct': 'too_big',
    });
    expect(await versions()).toBe(0);
  });

  it('gives Agents 403 on both routes (AC-3)', async () => {
    expect((await get(asAgent)).statusCode).toBe(403);
    expect((await put(asAgent, { version: null, rules: RULES })).statusCode).toBe(403);
  });

  it("keeps tenants apart: B can't read or overwrite A's rules (AC-10)", async () => {
    expect((await put(asA, { version: null, rules: RULES })).statusCode).toBe(200);
    const b = (await get(asB)).json();
    expect(b.version).toBeNull();
    // B saving version 1 writes B's own row; A's stays as it was.
    expect((await put(asB, { version: null, rules: SAFE })).statusCode).toBe(200);
    const rows = (
      await owner.query(`select tenant_id, version from boundary_rules order by tenant_id`)
    ).rows;
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenant_id: TENANT_A, version: 1 },
        { tenant_id: TENANT_B, version: 1 },
      ]),
    );
    expect((await get(asA)).json()).toMatchObject({ version: 1, rules: RULES });
  });
});
