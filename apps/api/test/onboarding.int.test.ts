/**
 * Onboarding progress and the go-live check (ONB-02, ONB-09; FEAT-035 §5.3; AC-1–AC-8): the
 * four routes, the gate on the Channels page's Go live, roles and tenant isolation.
 */
import { OnboardingStep, ReadinessKey } from '@kaki/contracts';
import { BAKERY_HOURS } from '@kaki/db/setup';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { CURRENT_TERMS } from '@kaki/identity';
import { ONBOARDING_STEPS, READINESS_KEYS } from '@kaki/tenancy';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
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
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const call = (method: 'GET' | 'PUT' | 'POST', url: string, who: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie: who },
    ...(payload !== undefined ? { payload: payload as string } : {}),
  });

interface Fresh {
  tenantId: string;
  userId: string;
  cookie: string;
}

/** A fresh sign-up: an Owner, no progress row, the widget offline (FEAT-034 trigger). */
async function freshTenant(): Promise<Fresh> {
  const tenantId = randomUUID();
  const slug = `t-${tenantId.slice(0, 8)}`;
  await owner.query(
    `insert into tenants (id, slug, name, widget_key) values ($1, $2, 'Fresh Cafe', $3)`,
    [tenantId, slug, `wk_${slug}`],
  );
  await owner.query(
    `insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`,
    [tenantId],
  );
  const email = `${slug}@fresh.test`;
  const u = await owner.query<{ id: string }>(
    `insert into users (email) values ($1) returning id`,
    [email],
  );
  const userId = u.rows[0]!.id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [
    tenantId,
    userId,
  ]);
  return { tenantId, userId, cookie: await sessionCookie(tdb, email) };
}

const fact = (tenantId: string, status: string, question: string) =>
  owner.query(
    `insert into facts (tenant_id, type, status, value, source)
     values ($1, 'faq', $2, jsonb_build_object('question', $3::text, 'answer', 'Yes.'), 'website')`,
    [tenantId, status, question],
  );

async function wording(tenantId: string, kind: string, column: string) {
  const w = await owner.query<{ id: string }>(
    `insert into wording_versions (tenant_id, kind, seq, content) values ($1, $2, 1, '{}') returning id`,
    [tenantId, kind],
  );
  await owner.query(
    `insert into privacy_settings (tenant_id, ${column}) values ($1, $2)
     on conflict (tenant_id) do update set ${column} = excluded.${column}`,
    [tenantId, w.rows[0]!.id],
  );
}

const fix: Record<ReadinessKey, (t: Fresh) => Promise<unknown>> = {
  profile: ({ tenantId }) =>
    owner.query(
      `update business_profiles set industry = 'fnb', contact_phone = '+6561234567',
         languages = '{en}', hours = $2 where tenant_id = $1`,
      [tenantId, JSON.stringify(BAKERY_HOURS)],
    ),
  approved_fact: ({ tenantId }) => fact(tenantId, 'approved', 'Do you deliver?'),
  disclosure: ({ tenantId }) =>
    owner.query(`insert into assistant_settings (tenant_id) values ($1)`, [tenantId]),
  purpose: ({ tenantId }) => wording(tenantId, 'purpose_statement', 'purpose_wording_id'),
  notice: ({ tenantId }) => wording(tenantId, 'privacy_notice', 'notice_wording_id'),
  terms: ({ tenantId, userId }) =>
    owner.query(
      `insert into terms_acceptances (tenant_id, user_id, document, version)
       select $1, $2, d.key, d.value from jsonb_each_text($3::jsonb) d`,
      [
        tenantId,
        userId,
        JSON.stringify(
          Object.fromEntries(Object.entries(CURRENT_TERMS).map(([k, v]) => [k, v.version])),
        ),
      ],
    ),
  rules: ({ tenantId, userId }) =>
    owner.query(`insert into boundary_rules (tenant_id, version, created_by) values ($1, 1, $2)`, [
      tenantId,
      userId,
    ]),
};

async function readyTenant() {
  const t = await freshTenant();
  for (const f of Object.values(fix)) await f(t);
  return t;
}

const widgetOf = async (t: Fresh) => {
  const r = (await call('GET', '/api/v1/onboarding/readiness', t.cookie)).json();
  return r.channels[0] as { id: string; version: number; state: string };
};
const goLive = (t: Fresh, ch: { id: string; version: number }, acknowledgeWarnings = false) =>
  call('POST', '/api/v1/onboarding/go-live', t.cookie, {
    channels: [{ id: ch.id, version: ch.version }],
    acknowledgeWarnings,
  });
const auditCount = async (tenantId: string, type: string) =>
  Number(
    (
      await owner.query(
        `select count(*) from audit_entries where tenant_id = $1 and event_type = $2`,
        [tenantId, type],
      )
    ).rows[0].count,
  );

describe('contracts match the domain', () => {
  it('has the same steps and readiness keys, in the same order', () => {
    expect(OnboardingStep.options).toEqual([...ONBOARDING_STEPS]);
    expect(ReadinessKey.options).toEqual([...READINESS_KEYS]);
  });
});

describe('progress (AC-1, AC-2)', () => {
  it('round-trips: never started, then visited, done and skipped', async () => {
    const t = await freshTenant();
    const get = async () => (await call('GET', '/api/v1/onboarding/progress', t.cookie)).json();
    expect(await get()).toEqual({ currentStep: 'profile', steps: {}, firstLiveAt: null });
    const put = (step: string, outcome: string) =>
      call('PUT', `/api/v1/onboarding/progress/${step}`, t.cookie, { outcome });
    expect((await put('profile', 'done')).json()).toMatchObject({ currentStep: 'sources' });
    expect((await put('sources', 'skipped')).json()).toEqual({
      currentStep: 'review',
      steps: { profile: 'done', sources: 'skipped' },
      firstLiveAt: null,
    });
    expect((await put('rules', 'visited')).json()).toMatchObject({ currentStep: 'rules' });
    expect(await get()).toMatchObject({ currentStep: 'rules' });
  });

  it('refuses skipping the profile or go-live, an unknown step and a bad outcome', async () => {
    const t = await freshTenant();
    const put = (step: string, payload: unknown) =>
      call('PUT', `/api/v1/onboarding/progress/${step}`, t.cookie, payload);
    for (const step of ['profile', 'go_live']) {
      const res = await put(step, { outcome: 'skipped' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('not_skippable');
    }
    expect((await put('billing', { outcome: 'done' })).statusCode).toBe(404);
    const bad = await put('sources', { outcome: 'later' });
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'invalid_body']);
  });
});

describe('readiness (AC-3, AC-5)', () => {
  it('lists all seven items in order, the warnings and the channels', async () => {
    const t = await freshTenant();
    await fix.profile(t);
    await fact(t.tenantId, 'needs_review', 'Halal?');
    const res = await call('GET', '/api/v1/onboarding/readiness', t.cookie);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.items).toEqual(READINESS_KEYS.map((key) => ({ key, ok: key === 'profile' })));
    expect(r).toMatchObject({
      ready: false,
      preLiveForm: false,
      firstLiveAt: null,
      warnings: { conflicts: 0, needsReview: 1 },
    });
    expect(r.channels).toEqual([expect.objectContaining({ kind: 'widget', state: 'offline' })]);
  });
});

describe('going live (AC-4, AC-5, AC-6, AC-7)', () => {
  it('409 not_ready lists exactly the failing keys and changes nothing, on both routes', async () => {
    const t = await freshTenant();
    await fix.profile(t);
    await fix.rules(t);
    const w = await widgetOf(t);
    const res = await goLive(t, w, true);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'not_ready',
      missing: ['approved_fact', 'disclosure', 'purpose', 'notice', 'terms'],
    });
    const viaChannels = await call('POST', `/api/v1/channels/${w.id}/live`, t.cookie, {
      version: w.version,
    });
    expect(viaChannels.statusCode).toBe(409);
    expect(viaChannels.json().missing).toEqual(res.json().missing);
    expect((await widgetOf(t)).state).toBe('offline');
    expect(await auditCount(t.tenantId, 'channel.live')).toBe(0);
    expect(await auditCount(t.tenantId, 'onboarding.first_live')).toBe(0);
    const p = (await call('GET', '/api/v1/onboarding/progress', t.cookie)).json();
    expect(p.firstLiveAt).toBeNull();
  });

  it('warnings need the acknowledgement on the check', async () => {
    const t = await readyTenant();
    await fact(t.tenantId, 'needs_review', 'Gift cards?');
    const w = await widgetOf(t);
    const res = await goLive(t, w, false);
    expect([res.statusCode, res.json().error]).toEqual([409, 'warnings_unacknowledged']);
    expect((await widgetOf(t)).state).toBe('offline');
    const ok = await goLive(t, w, true);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().channels[0].state).toBe('live');
    // Unreviewed facts stay out of visitor answers after going live: only the approved one shows.
    await owner.query('begin');
    try {
      await owner.query(`select set_config('app.tenant_id', $1, true)`, [t.tenantId]);
      const visible = await owner.query(
        `select v.value->>'question' as q from visitor_facts v order by 1`,
      );
      expect(visible.rows).toEqual([{ q: 'Do you deliver?' }]);
    } finally {
      await owner.query('rollback');
    }
  });

  it('ready: goes live, stamps the first go-live and audits it once; later the gate is gone', async () => {
    const t = await readyTenant();
    const w = await widgetOf(t);
    const res = await goLive(t, w);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.channels[0].state).toBe('live');
    expect(r.firstLiveAt).toEqual(expect.any(String));
    expect(await auditCount(t.tenantId, 'onboarding.first_live')).toBe(1);
    expect(await auditCount(t.tenantId, 'channel.live')).toBe(1);
    const p = (await call('GET', '/api/v1/onboarding/progress', t.cookie)).json();
    expect(p).toMatchObject({ currentStep: 'go_live', firstLiveAt: r.firstLiveAt });

    // An item fails after the first go-live: the Channels page still takes the widget live.
    await owner.query(`delete from boundary_rules where tenant_id = $1`, [t.tenantId]);
    const off = await call('POST', `/api/v1/channels/${w.id}/offline`, t.cookie, {
      version: r.channels[0].version,
    });
    expect(off.statusCode).toBe(200);
    const on = await call('POST', `/api/v1/channels/${w.id}/live`, t.cookie, {
      version: off.json().version,
    });
    expect([on.statusCode, on.json().state]).toEqual([200, 'live']);
    expect(await auditCount(t.tenantId, 'onboarding.first_live')).toBe(1);
  });

  it('a stale version is 409 version_conflict and nothing changes', async () => {
    const t = await readyTenant();
    const w = await widgetOf(t);
    const res = await goLive(t, { id: w.id, version: w.version + 5 });
    expect([res.statusCode, res.json().error]).toEqual([409, 'version_conflict']);
    expect(await auditCount(t.tenantId, 'onboarding.first_live')).toBe(0);
  });

  it('refuses a bad body', async () => {
    const t = await freshTenant();
    const res = await call('POST', '/api/v1/onboarding/go-live', t.cookie, { channels: [] });
    expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_body']);
  });
});

describe('roles and tenants (AC-8)', () => {
  it('an Agent gets 403 on every onboarding route', async () => {
    const routes: ['GET' | 'PUT' | 'POST', string, unknown?][] = [
      ['GET', '/api/v1/onboarding/progress'],
      ['PUT', '/api/v1/onboarding/progress/sources', { outcome: 'done' }],
      ['GET', '/api/v1/onboarding/readiness'],
      ['POST', '/api/v1/onboarding/go-live', { channels: [], acknowledgeWarnings: true }],
    ];
    for (const [method, url, body] of routes)
      expect((await call(method, url, asAgent, body)).statusCode, url).toBe(403);
  });

  it("tenant B reads only its own progress and can't go live with A's channel", async () => {
    const a = await readyTenant();
    const b = await readyTenant();
    await call('PUT', '/api/v1/onboarding/progress/review', a.cookie, { outcome: 'visited' });
    const pb = (await call('GET', '/api/v1/onboarding/progress', b.cookie)).json();
    expect(pb.currentStep).toBe('profile');
    const wa = await widgetOf(a);
    const res = await goLive(b, wa, true);
    expect(res.statusCode).toBe(404);
    expect((await widgetOf(a)).state).toBe('offline');
    expect(await auditCount(b.tenantId, 'onboarding.first_live')).toBe(0);
  });
});
