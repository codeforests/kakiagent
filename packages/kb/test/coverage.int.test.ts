/**
 * The coverage report and answering a coverage gap (KB-09, KB-18, UC-16 3b; FEAT-019
 * §5.3, AC-2, AC-3, AC-5–AC-9 kb half). Chunk vectors are set to crafted axes, so
 * "near" and "far" don't depend on the fake embedder.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptCorrection,
  coverageReport,
  createFact,
  dashboardKb,
  dismissCorrection,
  getCorrection,
  InvalidCorrectionError,
  NotEditableError,
  prepareChunk,
  type CoverageInput,
  type FactInput,
  type GapStat,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const llm = gatewayFromConfig({ provider: 'fake' });
const USER = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-24T04:00:00.000Z');

const axis = (i: number, tilt = 0) => {
  const v = new Array<number>(1024).fill(0);
  v[i] = 1;
  v[i + 1] = tilt;
  const n = Math.hypot(1, tilt);
  return v.map((x) => x / n);
};
const key = (q: string) => q.trim().toLowerCase().replace(/\?$/, '');

const TOPICS = [
  { id: 'fnb.custom-orders', question: 'Do you take custom cake orders?', hint: 'h' },
  { id: 'fnb.delivery', question: 'Do you deliver?', hint: 'h' },
  { id: 'fnb.halal', question: 'Are you halal certified?', hint: 'h' },
  { id: 'fnb.dine-in', question: 'Do you have seating for dine-in?', hint: 'h' },
  { id: 'fnb.payment', question: 'How can I pay?', hint: 'h' },
];
/** Topic → the axis its question embeds to. */
const TOPIC_AXIS: Record<string, number> = {
  'Do you take custom cake orders?': 900,
  'Do you deliver?': 10,
  'Are you halal certified?': 20,
  'Do you have seating for dine-in?': 30,
  'How can I pay?': 40,
};

async function fact(
  tenantId: string,
  input: FactInput,
  opts: { axis?: number; status?: string } = {},
) {
  const chunk = await prepareChunk(llm, tenantId, input);
  const f = await withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    createFact(dashboardKb(tx, tenantId, USER), input, chunk),
  );
  if (opts.axis !== undefined)
    await owner.query(`update kb_chunks set embedding = $1 where fact_id = $2`, [
      `[${axis(opts.axis).join(',')}]`,
      f.id,
    ]);
  if (opts.status)
    await owner.query(`update facts set status = $1 where id = $2`, [opts.status, f.id]);
  return f.id;
}
const faq = (question: string, answer = 'Yes.'): FactInput => ({
  type: 'faq',
  value: { question, answer },
  gstTreatment: null,
});

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    template: { industry: 'fnb', topics: TOPICS },
    skipped: [],
    keyOf: key,
    embedTopics: async (qs) => qs.map((q) => axis(TOPIC_AXIS[q]!)),
    live: false,
    gapStats: async () => new Map(),
    now: NOW,
    ...over,
  };
}
const report = (tenantId: string, over: Partial<CoverageInput> = {}) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    coverageReport(dashboardKb(tx, tenantId, USER), input(over)),
  );

async function gapItem(tenantId: string, status = 'open') {
  const { rows } = await owner.query(
    `insert into corrections (tenant_id, source_type, proposed_by, proposed_change, status, decided_at)
     values ($1, 'coverage_gap', 'system', '{"kind":"answer_gap"}', $2, case when $2 = 'open' then null else now() end)
     returning id`,
    [tenantId, status],
  );
  return rows[0].id as string;
}
const stat = (over: Partial<GapStat> = {}): GapStat => ({
  asksSince: 1,
  asksTotal: 1,
  firstAskedAt: new Date('2026-10-01T00:00:00.000Z'),
  lastAskedAt: new Date('2026-10-20T00:00:00.000Z'),
  reasons: ['unavailable'],
  newest: 'Can I pay by PayNow?',
  ...over,
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
beforeEach(async () => {
  await owner.query(`delete from messages`);
  await owner.query(`delete from corrections`);
  await owner.query(`delete from kb_chunks`);
  await owner.query(`delete from fact_versions`);
  await owner.query(`delete from facts`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('coverageReport topics (AC-2, AC-3, AC-9)', () => {
  it('covers by FAQ key and by a near visible fact; never by unreviewed, disabled or conflicted facts', async () => {
    const custom = await fact(TENANT_A, faq('do you take custom cake orders'), { axis: 500 });
    const delivery = await fact(
      TENANT_A,
      {
        type: 'product',
        value: { name: 'Island-wide delivery', priceCents: 1500, currency: 'SGD' },
        gstTreatment: 'inclusive',
      },
      { axis: 10 },
    );
    // Exactly on the halal, dine-in and payment axes, but not visible to visitors.
    await fact(TENANT_A, faq('Halal?'), { axis: 20, status: 'needs_review' });
    await fact(TENANT_A, faq('Seats?'), { axis: 30, status: 'disabled' });
    await fact(TENANT_A, faq('Pay?'), { axis: 40, status: 'conflicted' });
    // Another tenant's facts never count.
    await fact(TENANT_B, faq('Do you have seating for dine-in?'), { axis: 30 });

    const r = await report(TENANT_A, { skipped: ['fnb.payment'] });
    expect(r.stage).toBe('pre_live');
    expect(r.template?.checked).toBe('meaning');
    expect(r.template?.topics.map((t) => [t.id, t.state, t.coveredBy?.factId ?? null])).toEqual([
      ['fnb.custom-orders', 'covered', custom],
      ['fnb.delivery', 'covered', delivery],
      ['fnb.halal', 'missing', null],
      ['fnb.dine-in', 'missing', null],
      ['fnb.payment', 'skipped', null],
    ]);
    expect(r.template?.topics[1]!.coveredBy).toEqual({
      factId: delivery,
      type: 'product',
      label: 'Island-wide delivery',
    });
    expect(r.summary).toEqual({ topicsTotal: 5, topicsMissing: 2, openGaps: 0 });

    // Un-skipping restores the computed state; a near fact (within 0.35) covers too.
    await fact(TENANT_A, faq('Ways to pay'), { axis: 40 });
    await owner.query(
      `update kb_chunks set embedding = $1 where fact_id = (select id from facts where value->>'question' = 'Ways to pay')`,
      [`[${axis(40, 0.5).join(',')}]`],
    );
    const again = await report(TENANT_A);
    expect(again.template?.topics.find((t) => t.id === 'fnb.payment')?.state).toBe('covered');
    // A far fact (cosine distance 1) doesn't.
    expect(again.template?.topics.find((t) => t.id === 'fnb.halal')?.state).toBe('missing');
  });

  it('falls back to key matching when the topics cannot be embedded', async () => {
    await fact(TENANT_A, faq('Do you take custom cake orders?'), { axis: 500 });
    await fact(TENANT_A, faq('Delivery'), { axis: 10 });
    const r = await report(TENANT_A, {
      embedTopics: async () => {
        throw new Error('embedder down');
      },
    });
    expect(r.template?.checked).toBe('question_only');
    expect(r.template?.topics.map((t) => t.state)).toEqual([
      'covered',
      'missing',
      'missing',
      'missing',
      'missing',
    ]);
  });

  it('has no template section for a tenant without one, and says live after the first conversation', async () => {
    const r = await report(TENANT_B, { template: null, live: true });
    expect(r).toMatchObject({ stage: 'live', template: null, gaps: [] });
    expect(r.summary).toEqual({ topicsTotal: 0, topicsMissing: 0, openGaps: 0 });
  });
});

describe('coverageReport gaps (AC-6)', () => {
  it('lists open items by asks in 30 days, then the latest ask, at most 20, with the newest question', async () => {
    const closed = await gapItem(TENANT_A, 'dismissed');
    const ids = [] as string[];
    for (let i = 0; i < 23; i++) ids.push(await gapItem(TENANT_A));
    let asked: { ids: string[]; since: Date } | null = null;
    const r = await report(TENANT_A, {
      live: true,
      gapStats: async (correctionIds, since) => {
        asked = { ids: correctionIds, since };
        return new Map([
          ...ids
            .slice(3)
            .map(
              (id, i) =>
                [
                  id,
                  stat({ asksSince: 1, lastAskedAt: new Date(Date.UTC(2026, 9, 1 + i)) }),
                ] as const,
            ),
          [ids[0]!, stat({ asksSince: 5, asksTotal: 9, reasons: ['unavailable', 'escalated'] })],
          [ids[1]!, stat({ asksSince: 0, asksTotal: 7 })],
          // Every question erased: left for the job to close.
          [ids[2]!, stat({ asksTotal: 0, newest: null })],
        ]);
      },
    });
    expect(asked!.ids).not.toContain(closed);
    expect(asked!.ids).toHaveLength(23);
    expect(asked!.since).toEqual(new Date('2026-09-24T04:00:00.000Z'));
    expect(r.gaps).toHaveLength(20);
    expect(r.gaps[0]).toEqual({
      correctionId: ids[0],
      question: 'Can I pay by PayNow?',
      asks30d: 5,
      asksTotal: 9,
      firstAskedAt: new Date('2026-10-01T00:00:00.000Z'),
      lastAskedAt: new Date('2026-10-20T00:00:00.000Z'),
      reasons: ['unavailable', 'escalated'],
    });
    // Then the one-ask items, latest ask first.
    expect(r.gaps[1]!.correctionId).toBe(ids[22]);
    expect(r.gaps.map((g) => g.correctionId)).not.toContain(ids[1]);
    expect(r.gaps.map((g) => g.correctionId)).not.toContain(ids[2]);
    expect(r.summary.openGaps).toBe(22);
  });
});

describe('answering a coverage gap (AC-7, AC-8)', () => {
  const dash = (tenantId: string) => (fn: Parameters<typeof withTenant>[2]) =>
    withTenant(tdb.zone('dashboard'), tenantId, fn);

  async function gapWithQuestion(tenantId: string) {
    const id = await gapItem(tenantId);
    const conv = await owner.query(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
      [tenantId],
    );
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, gap_reason, gap_embedding, gap_correction_id)
       values ($1, $2, 'visitor', 'Visitor secret: can I pay with NETS?', 'unavailable', $3, $4)`,
      [tenantId, conv.rows[0].id, `[${axis(0).join(',')}]`, id],
    );
    return id;
  }

  it('accepting with an FAQ creates an approved FAQ visitors get, edited_and_accepted, and drops it from the report', async () => {
    const id = await gapWithQuestion(TENANT_A);
    const edit = {
      kind: 'add_faq' as const,
      question: 'Can I pay with NETS?',
      answer: 'Yes, at the counter.',
    };
    const chunk = await prepareChunk(llm, TENANT_A, faq(edit.question, edit.answer));
    const out = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      acceptCorrection(dashboardKb(tx, TENANT_A, USER), id, { edit, chunk }),
    );
    expect(out.status).toBe('edited_and_accepted');
    expect(out.change).toEqual({ kind: 'answer_gap' });
    expect(out.acceptedChange).toEqual(edit);
    await owner.query('begin');
    await owner.query(`select set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const visible = await owner.query(
      `select type, value from visitor_facts where value->>'question' = 'Can I pay with NETS?'`,
    );
    await owner.query('rollback');
    expect(visible.rows).toEqual([
      { type: 'faq', value: { question: 'Can I pay with NETS?', answer: 'Yes, at the counter.' } },
    ]);
    let seen: string[] = [];
    await report(TENANT_A, {
      gapStats: async (ids) => ((seen = ids), new Map()),
    });
    expect(seen).not.toContain(id);
    // No visitor text in the item or the audit trail (ADR-014, ADR-015).
    const trail = await owner.query(
      `select (select json_agg(c) from corrections c where c.id = $1) as item,
              (select json_agg(a.payload) from audit_entries a where a.tenant_id = $2) as audit`,
      [id, TENANT_A],
    );
    expect(JSON.stringify(trail.rows[0])).not.toContain('Visitor secret');
  });

  it('refuses an accept without an FAQ, or with a fact edit; closing changes no fact', async () => {
    const id = await gapWithQuestion(TENANT_A);
    await expect(
      dash(TENANT_A)((tx) => acceptCorrection(dashboardKb(tx, TENANT_A, USER), id)),
    ).rejects.toBeInstanceOf(InvalidCorrectionError);
    await expect(
      dash(TENANT_A)((tx) =>
        acceptCorrection(dashboardKb(tx, TENANT_A, USER), id, {
          edit: { kind: 'add_faq', question: ' ', answer: 'x' },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCorrectionError);
    await expect(
      dash(TENANT_A)((tx) =>
        acceptCorrection(dashboardKb(tx, TENANT_A, USER), id, {
          edit: { kind: 'edit_fact', patch: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NotEditableError);
    const before = (await owner.query(`select count(*)::int as n from facts`)).rows[0];
    const closed = await dash(TENANT_A)((tx) =>
      dismissCorrection(dashboardKb(tx, TENANT_A, USER), id),
    );
    expect((closed as { status: string }).status).toBe('dismissed');
    expect((await owner.query(`select count(*)::int as n from facts`)).rows[0]).toEqual(before);
    // Tenant B can't see the item.
    await expect(
      dash(TENANT_B)((tx) => getCorrection({ tx, tenantId: TENANT_B }, id)),
    ).rejects.toThrow();
  });
});
