/**
 * Onboarding progress and the go-live check (FEAT-035 §5.2; AC-1–AC-7): progress round-trip
 * and skip rules, each readiness item from its own source, and the first-go-live gate.
 */
import { withTenant, type Tx } from '@kaki/db';
import { BAKERY_HOURS } from '@kaki/db/setup';
import { startTestDatabase, type TestDatabase } from '@kaki/db/testing';
import { CURRENT_TERMS } from '@kaki/identity';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getProgress,
  goLive,
  goLiveOne,
  goLiveReadiness,
  NotReadyError,
  NotSkippableError,
  recordStep,
  WarningsUnacknowledgedError,
  type ReadinessKey,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const TODAY = '2026-10-30';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);

/** A fresh sign-up: no progress row, widget offline (FEAT-034 trigger), an empty profile. */
async function freshTenant() {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await owner.query(
    `insert into tenants (id, slug, name, widget_key) values ($1, $2, 'Fresh Cafe', $3)`,
    [id, slug, `wk_${slug}`],
  );
  await owner.query(
    `insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`,
    [id],
  );
  const user = await owner.query<{ id: string }>(
    `insert into users (email) values ($1) returning id`,
    [`${slug}@fresh.test`],
  );
  return { tenantId: id, userId: user.rows[0]!.id };
}

/** Each item's own input, set as the owning feature would store it. */
const fix: Record<ReadinessKey, (t: { tenantId: string; userId: string }) => Promise<unknown>> = {
  profile: ({ tenantId }) =>
    owner.query(
      `update business_profiles set industry = 'fnb', contact_email = 'hi@fresh.test',
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

const fact = (tenantId: string, status: string, question: string) =>
  owner.query(
    `insert into facts (tenant_id, type, status, value, source)
     values ($1, 'faq', $2, jsonb_build_object('question', $3::text, 'answer', 'Yes.'), 'website')`,
    [tenantId, status, question],
  );

async function wording(tenantId: string, kind: string, column: string) {
  const w = await owner.query<{ id: string }>(
    `insert into wording_versions (tenant_id, kind, seq, content) values ($1, $2, 1, '{}')
     returning id`,
    [tenantId, kind],
  );
  await owner.query(
    `insert into privacy_settings (tenant_id, ${column}) values ($1, $2)
     on conflict (tenant_id) do update set ${column} = excluded.${column}`,
    [tenantId, w.rows[0]!.id],
  );
}

async function readyTenant() {
  const t = await freshTenant();
  for (const f of Object.values(fix)) await f(t);
  return t;
}

const widget = async (tenantId: string) =>
  (
    await owner.query<{ id: string; version: number; state: string }>(
      `select id, version, state from channel_connections where tenant_id = $1 and kind = 'widget'`,
      [tenantId],
    )
  ).rows[0]!;

const audits = async (tenantId: string, type: string) =>
  (
    await owner.query(
      `select actor_ref, payload from audit_entries where tenant_id = $1 and event_type = $2`,
      [tenantId, type],
    )
  ).rows;

const missingOf = (e: unknown) => (e instanceof NotReadyError ? e.missing : e);

describe('onboarding progress (AC-1, AC-2)', () => {
  it('no row reads as the profile step, nothing done, never live', async () => {
    const { tenantId } = await freshTenant();
    expect(await dash(tenantId, (tx) => getProgress(tx, tenantId))).toEqual({
      currentStep: 'profile',
      steps: {},
      firstLiveAt: null,
    });
  });

  it('visited moves the step; done and skipped record it and move on; profile and go-live never skip', async () => {
    const { tenantId } = await freshTenant();
    const rec = (step: Parameters<typeof recordStep>[2], o: Parameters<typeof recordStep>[3]) =>
      dash(tenantId, (tx) => recordStep(tx, tenantId, step, o));
    await expect(rec('profile', 'skipped')).rejects.toBeInstanceOf(NotSkippableError);
    await expect(rec('go_live', 'skipped')).rejects.toBeInstanceOf(NotSkippableError);
    expect(await rec('profile', 'done')).toMatchObject({ currentStep: 'sources' });
    expect(await rec('sources', 'skipped')).toMatchObject({
      currentStep: 'review',
      steps: { profile: 'done', sources: 'skipped' },
    });
    expect(await rec('sources', 'visited')).toMatchObject({ currentStep: 'sources' });
    expect(await rec('sources', 'done')).toMatchObject({
      currentStep: 'review',
      steps: { profile: 'done', sources: 'done' },
    });
    expect(await rec('go_live', 'done')).toMatchObject({ currentStep: 'go_live' });
    // A new transaction (a new session) reads the same.
    expect(await dash(tenantId, (tx) => getProgress(tx, tenantId))).toMatchObject({
      currentStep: 'go_live',
      steps: { profile: 'done', sources: 'done', go_live: 'done' },
    });
  });
});

describe('go-live readiness (AC-3, AC-5)', () => {
  it('each item flips on its own input and only that one', async () => {
    const t = await freshTenant();
    const failing = async () =>
      (await dash(t.tenantId, (tx) => goLiveReadiness(tx, t.tenantId, t.userId, TODAY))).items
        .filter((i) => !i.ok)
        .map((i) => i.key);
    const all: ReadinessKey[] = [
      'profile',
      'approved_fact',
      'disclosure',
      'purpose',
      'notice',
      'terms',
      'rules',
    ];
    expect(await failing()).toEqual(all);
    for (const [i, key] of all.entries()) {
      await fix[key](t);
      expect(await failing(), key).toEqual(all.slice(i + 1));
    }
    const r = await dash(t.tenantId, (tx) => goLiveReadiness(tx, t.tenantId, t.userId, TODAY));
    expect(r).toMatchObject({ ready: true, preLiveForm: true, firstLiveAt: null });
  });

  it('a UEN is optional; a profile without a contact or hours is not complete', async () => {
    const t = await freshTenant();
    await fix.profile(t);
    const profileOk = async () =>
      (await dash(t.tenantId, (tx) => goLiveReadiness(tx, t.tenantId, t.userId, TODAY))).items[0];
    expect(await profileOk()).toEqual({ key: 'profile', ok: true });
    await owner.query(`update business_profiles set contact_email = null where tenant_id = $1`, [
      t.tenantId,
    ]);
    expect(await profileOk()).toEqual({ key: 'profile', ok: false });
  });

  it('counts conflicts and facts waiting for review as warnings', async () => {
    const t = await freshTenant();
    await fact(t.tenantId, 'needs_review', 'Open on Sunday?');
    await fact(t.tenantId, 'conflicted', 'Halal?');
    const r = await dash(t.tenantId, (tx) => goLiveReadiness(tx, t.tenantId, t.userId, TODAY));
    expect(r.warnings).toEqual({ conflicts: 1, needsReview: 1 });
  });
});

describe('going live (AC-4, AC-6, AC-7)', () => {
  it('blocked: lists exactly the failing keys and changes nothing', async () => {
    const t = await freshTenant();
    await fix.profile(t);
    await fix.terms(t);
    const w = await widget(t.tenantId);
    const err = await dash(t.tenantId, (tx) =>
      goLive(tx, { ...t, channels: [w], acknowledgeWarnings: true, today: TODAY }),
    ).catch(missingOf);
    expect(err).toEqual(['approved_fact', 'disclosure', 'purpose', 'notice', 'rules']);
    expect((await widget(t.tenantId)).state).toBe('offline');
    expect(await audits(t.tenantId, 'channel.live')).toEqual([]);
    expect(await audits(t.tenantId, 'onboarding.first_live')).toEqual([]);
    expect(await dash(t.tenantId, (tx) => getProgress(tx, t.tenantId))).toMatchObject({
      firstLiveAt: null,
    });
    // The Channels page's route is gated the same way.
    const one = await dash(t.tenantId, (tx) =>
      goLiveOne(tx, { ...t, id: w.id, version: w.version, today: TODAY }),
    ).catch(missingOf);
    expect(one).toEqual(['approved_fact', 'disclosure', 'purpose', 'notice', 'rules']);
  });

  it('warnings need the acknowledgement on the check, never on the Channels page', async () => {
    const t = await readyTenant();
    await fact(t.tenantId, 'needs_review', 'Gift cards?');
    const w = await widget(t.tenantId);
    await expect(
      dash(t.tenantId, (tx) =>
        goLive(tx, { ...t, channels: [w], acknowledgeWarnings: false, today: TODAY }),
      ),
    ).rejects.toBeInstanceOf(WarningsUnacknowledgedError);
    expect((await widget(t.tenantId)).state).toBe('offline');
    const item = await dash(t.tenantId, (tx) =>
      goLiveOne(tx, { ...t, id: w.id, version: w.version, today: TODAY }),
    );
    expect(item.state).toBe('live');
  });

  it('ready: goes live, stamps the first go-live and audits it once', async () => {
    const t = await readyTenant();
    await owner.query(
      `update tenants set created_at = now() - interval '95 minutes' where id = $1`,
      [t.tenantId],
    );
    const w = await widget(t.tenantId);
    const items = await dash(t.tenantId, (tx) =>
      goLive(tx, { ...t, channels: [w], acknowledgeWarnings: false, today: TODAY }),
    );
    expect(items.map((i) => i.state)).toEqual(['live']);
    const p = await dash(t.tenantId, (tx) => getProgress(tx, t.tenantId));
    expect(p.currentStep).toBe('go_live');
    expect(p.firstLiveAt).toBeInstanceOf(Date);
    expect(await audits(t.tenantId, 'onboarding.first_live')).toEqual([
      { actor_ref: t.userId, payload: { minutesToLive: 95, channels: [w.id] } },
    ]);
    expect(await audits(t.tenantId, 'channel.live')).toHaveLength(1);

    // Later go-lives skip the gate and don't re-audit, even with an item failing.
    await owner.query(`delete from boundary_rules where tenant_id = $1`, [t.tenantId]);
    await owner.query(`update channel_connections set state = 'offline' where id = $1`, [w.id]);
    const again = await widget(t.tenantId);
    await dash(t.tenantId, (tx) =>
      goLive(tx, { ...t, channels: [again], acknowledgeWarnings: false, today: TODAY }),
    );
    await owner.query(`update channel_connections set state = 'offline' where id = $1`, [w.id]);
    const third = await widget(t.tenantId);
    await dash(t.tenantId, (tx) =>
      goLiveOne(tx, { ...t, id: third.id, version: third.version, today: TODAY }),
    );
    expect((await widget(t.tenantId)).state).toBe('live');
    expect(await audits(t.tenantId, 'onboarding.first_live')).toHaveLength(1);
    expect((await dash(t.tenantId, (tx) => getProgress(tx, t.tenantId))).firstLiveAt).toEqual(
      p.firstLiveAt,
    );
  });
});
