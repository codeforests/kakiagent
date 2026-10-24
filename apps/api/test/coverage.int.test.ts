/**
 * The coverage report over HTTP on the fake provider (KB-09, KB-18, UC-16 3b; FEAT-019
 * §3, §5.5; AC-1–AC-3, AC-6, AC-7, AC-9).
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { runGapCluster } from '@kaki/kb';
import { createFakeProvider, createGateway, defaultRegistry } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asStaff: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(
    `update business_profiles set industry = 'fnb', coverage_skipped_topics = '{}'`,
  );
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asStaff = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const call = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  who: string | null,
  payload?: unknown,
  on = app,
) =>
  on.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload } : {}),
  });
const report = async (who = asA, on = app) => {
  const res = await call('GET', '/api/v1/kb/coverage', who, undefined, on);
  expect(res.statusCode).toBe(200);
  return res.json();
};
const topicState = (r: { template: { topics: { id: string; state: string }[] } }, id: string) =>
  r.template.topics.find((t) => t.id === id)?.state;

/** A visitor question the turn couldn't answer, marked as a gap, in a new conversation. */
async function gapQuestion(tenantId: string, body: string, axis: number) {
  const conv = await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
    [tenantId],
  );
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, gap_reason, gap_embedding)
     values ($1, $2, 'visitor', $3, 'unavailable', $4)`,
    [tenantId, conv.rows[0].id, body, `[${v.join(',')}]`],
  );
}

describe('who reaches coverage (AC-1)', () => {
  it('needs kb.manage and a session', async () => {
    expect((await call('GET', '/api/v1/kb/coverage', null)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/kb/coverage', asStaff)).statusCode).toBe(403);
    expect(
      (await call('PUT', '/api/v1/kb/coverage/topics/fnb.dine-in', asStaff, { skipped: true }))
        .statusCode,
    ).toBe(403);
  });
});

describe('template topics (AC-2, AC-3, AC-9)', () => {
  it('lists the F&B topics pre-live, covers one after an FAQ is added, and skips per tenant', async () => {
    const before = await report();
    expect(before.stage).toBe('pre_live');
    expect(before.template.industry).toBe('fnb');
    expect(before.template.checked).toBe('meaning');
    expect(topicState(before, 'fnb.payment')).toBe('missing');
    expect(before.summary.topicsTotal).toBe(before.template.topics.length);

    const faq = await call('POST', '/api/v1/kb/facts', asA, {
      type: 'faq',
      value: { question: 'How can I pay', answer: 'PayNow, card or cash.' },
    });
    expect(faq.statusCode).toBe(201);
    const after = await report();
    expect(after.template.topics.find((t: { id: string }) => t.id === 'fnb.payment')).toMatchObject(
      { state: 'covered', coveredBy: { factId: faq.json().fact.id, type: 'faq' } },
    );

    const skip = await call('PUT', '/api/v1/kb/coverage/topics/fnb.dine-in', asA, {
      skipped: true,
    });
    expect(skip.statusCode).toBe(200);
    expect(skip.json().topic).toMatchObject({
      id: 'fnb.dine-in',
      state: 'skipped',
      coveredBy: null,
    });
    // Tenant B's report is its own.
    const b = await report(asB);
    expect(topicState(b, 'fnb.dine-in')).toBe('missing');
    expect(topicState(b, 'fnb.payment')).toBe('missing');
    const unskip = await call('PUT', '/api/v1/kb/coverage/topics/fnb.dine-in', asA, {
      skipped: false,
    });
    expect(unskip.json().topic.state).toBe('missing');
  });

  it('404 for an unknown topic, 422 for a bad body', async () => {
    const res = await call('PUT', '/api/v1/kb/coverage/topics/fnb.nope', asA, { skipped: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect(
      (await call('PUT', '/api/v1/kb/coverage/topics/fnb.dine-in', asA, { skipped: 'yes' }))
        .statusCode,
    ).toBe(422);
  });

  it('still reports, by question only, when the embedder fails', async () => {
    const failing = await testApp(tdb, {
      llm: createGateway(defaultRegistry('fake'), [
        {
          ...createFakeProvider(() => 'x'),
          embed: async () => {
            throw new Error('embedder down');
          },
        },
      ]),
    });
    try {
      const r = await report(asA, failing);
      expect(r.template.checked).toBe('question_only');
      expect(topicState(r, 'fnb.payment')).toBe('covered');
    } finally {
      await failing.close();
    }
  });
});

describe('gaps (AC-6, AC-7)', () => {
  it('lists grouped gaps once live, answers one with an FAQ, and keeps tenants apart', async () => {
    await gapQuestion(TENANT_A, 'Do you sell durian cake?', 0);
    await gapQuestion(TENANT_A, 'Any durian cakes?', 0);
    await gapQuestion(TENANT_A, 'Can I park nearby?', 5);
    await gapQuestion(TENANT_B, 'Tenant B question', 0);
    await runGapCluster(tdb.zone('outbox'));

    const r = await report();
    expect(r.stage).toBe('live');
    expect(r.summary.openGaps).toBe(2);
    expect(r.gaps[0]).toMatchObject({
      question: 'Any durian cakes?',
      asks30d: 2,
      asksTotal: 2,
      reasons: ['unavailable'],
    });
    expect(JSON.stringify(r)).not.toContain('Tenant B question');
    const id = r.gaps[0].correctionId as string;

    // The queue shows the same item, with its newest ask, and the detail its questions.
    const list = await call('GET', '/api/v1/corrections?source=coverage_gap', asA);
    expect(list.json().corrections.find((c: { id: string }) => c.id === id)).toMatchObject({
      source: 'coverage_gap',
      proposedBy: 'system',
      change: { kind: 'answer_gap' },
      gap: { question: 'Any durian cakes?', asksTotal: 2 },
    });
    const detail = await call('GET', `/api/v1/corrections/${id}`, asA);
    expect(detail.json().context).toMatchObject({
      conversation: null,
      gap: { asks30d: 2, asksTotal: 2 },
    });
    expect(detail.json().context.gap.questions.map((q: { body: string }) => q.body)).toEqual([
      'Any durian cakes?',
      'Do you sell durian cake?',
    ]);
    expect((await call('GET', `/api/v1/corrections/${id}`, asB)).statusCode).toBe(404);

    // Accepting needs an FAQ.
    const bare = await call('POST', `/api/v1/corrections/${id}/accept`, asA, { edit: null });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().error).toBe('invalid_correction');
    const wrong = await call('POST', `/api/v1/corrections/${id}/accept`, asA, {
      edit: {
        kind: 'edit_fact',
        after: { value: {}, gstTreatment: null, validFrom: null, validUntil: null },
      },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toBe('not_editable');

    const ok = await call('POST', `/api/v1/corrections/${id}/accept`, asA, {
      edit: { kind: 'add_faq', question: 'Do you sell durian cake?', answer: 'In season, yes.' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().correction).toMatchObject({
      status: 'edited_and_accepted',
      acceptedChange: { kind: 'add_faq', question: 'Do you sell durian cake?' },
    });
    expect(ok.json().replay).toBeNull();
    const facts = await call('GET', '/api/v1/kb/facts?type=faq', asA);
    expect(JSON.stringify(facts.json())).toContain('In season, yes.');
    const after = await report();
    expect(after.gaps.map((g: { correctionId: string }) => g.correctionId)).not.toContain(id);
    expect(after.summary.openGaps).toBe(1);
  });
});
