/**
 * Assistant settings endpoints (FEAT-024 §3; AC-1, AC-2, AC-8, AC-9) and the widget
 * config's name and greeting.
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
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
beforeEach(async () => {
  await owner.query(`delete from assistant_settings`);
});

const URL = '/api/v1/settings/assistant';
const call = (method: 'GET' | 'PUT', who: string, payload?: unknown) =>
  app.inject({ method, url: URL, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const NONE = { en: null, zh: null };
const body = (over: Record<string, unknown> = {}) => ({
  version: 0,
  botName: 'Kaki',
  tone: 'friendly',
  emoji: true,
  greeting: { en: 'Hi! Ask me about our cakes.', zh: '' },
  disclosureNote: { en: 'Our team reads every chat.', zh: null },
  afterHoursMessage: NONE,
  fallbackMessage: { en: '   ', zh: '我们会尽快回复。' },
  ...over,
});

describe('GET /api/v1/settings/assistant', () => {
  it('returns the defaults and the default texts with the business name', async () => {
    const res = await call('GET', asA);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.settings).toEqual({
      version: 0,
      botName: null,
      tone: 'friendly',
      emoji: false,
      greeting: NONE,
      disclosureNote: NONE,
      afterHoursMessage: NONE,
      fallbackMessage: NONE,
      updatedAt: null,
    });
    expect(json.defaults.botName).toBe('Assistant');
    expect(json.defaults.disclosureCore.en).toEqual({
      named: "You're chatting with {name}, an AI assistant for Kaki Bakery.",
      unnamed: "You're chatting with an AI assistant for Kaki Bakery.",
    });
    expect(json.defaults.greeting.en).toBe('Ask us anything. We usually reply right away.');
    expect(json.defaults.afterHoursLead.en).toContain('{when}');
  });

  it('is for Owners and Admins only', async () => {
    expect((await call('GET', asAgent)).statusCode).toBe(403);
    expect((await call('PUT', asAgent, body())).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
  });
});

describe('PUT /api/v1/settings/assistant', () => {
  it('saves the whole document, blanks as defaults, and bumps the version', async () => {
    const first = await call('PUT', asA, body());
    expect(first.statusCode).toBe(200);
    expect(first.json().settings).toMatchObject({
      version: 1,
      botName: 'Kaki',
      emoji: true,
      greeting: { en: 'Hi! Ask me about our cakes.', zh: null },
      fallbackMessage: { en: null, zh: '我们会尽快回复。' },
    });
    expect(first.json().settings.updatedAt).toMatch(/^\d{4}-/);
    const second = await call('PUT', asA, body({ version: 1, tone: 'professional' }));
    expect(second.json().settings).toMatchObject({ version: 2, tone: 'professional' });
    expect((await call('GET', asA)).json().settings).toEqual(second.json().settings);
    // Tenant B is unaffected.
    expect((await call('GET', asB)).json().settings.botName).toBeNull();
    const audit = await owner.query(
      `select payload from audit_entries where event_type = 'settings.assistant_updated' and tenant_id = $1 order by seq`,
      [TENANT_A],
    );
    expect(audit.rows.map((r) => r.payload.version)).toEqual([1, 2]);
    expect(audit.rows[1].payload.fields).toEqual(['tone']);
  });

  it('409 on a stale version, including a second first save', async () => {
    expect((await call('PUT', asA, body())).statusCode).toBe(200);
    for (const version of [0, 7]) {
      const res = await call('PUT', asA, body({ version, botName: 'Late' }));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'version_conflict',
        message: 'These settings were changed by someone else',
      });
    }
    expect((await call('GET', asA)).json().settings.botName).toBe('Kaki');
  });

  it.each([
    ['a name with a digit', { botName: 'Kaki 2' }],
    ['a name over 30 characters', { botName: 'K'.repeat(31) }],
    ['a name with symbols', { botName: 'Kaki!' }],
    ['an unknown tone', { tone: 'sassy' }],
    ['emoji that is not a boolean', { emoji: 'yes' }],
    ['a greeting over 200 characters', { greeting: { en: 'g'.repeat(201), zh: null } }],
    ['a note over 200 characters', { disclosureNote: { en: null, zh: '注'.repeat(201) } }],
    ['an after-hours message over 300', { afterHoursMessage: { en: 'a'.repeat(301), zh: null } }],
    ['a fallback over 300', { fallbackMessage: { en: 'f'.repeat(301), zh: null } }],
    ['a missing language key', { greeting: { en: 'Hi' } }],
    ['a negative version', { version: -1 }],
  ])('400 for %s, and nothing is saved', async (_label, over) => {
    const res = await call('PUT', asA, body(over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect((await call('GET', asA)).json().settings.version).toBe(0);
  });

  it('accepts names in other scripts and with apostrophes', async () => {
    const res = await call('PUT', asA, body({ botName: "小卡 O'Neil-Tan" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.botName).toBe("小卡 O'Neil-Tan");
  });
});

describe('GET /widget/v1/config (FEAT-024 §3.4)', () => {
  const config = () =>
    app.inject({
      method: 'GET',
      url: '/widget/v1/config?key=wk_dev_bakery',
      headers: { origin: 'http://localhost:5175' },
    });

  it("returns the tenant's name and greeting, defaults when unset", async () => {
    const before = (await config()).json();
    expect(before.botName).toBe('Assistant');
    expect(before.greeting).toEqual({
      en: 'Ask us anything. We usually reply right away.',
      zh: '有什么问题都可以问我们，我们通常会马上回复。',
    });
    await call('PUT', asA, body());
    const after = (await config()).json();
    expect(after.botName).toBe('Kaki');
    expect(after.greeting).toEqual({
      en: 'Hi! Ask me about our cakes.',
      zh: '有什么问题都可以问我们，我们通常会马上回复。',
    });
  });
});
