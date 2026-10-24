/**
 * The corrections queue over HTTP on the fake provider (KB-18, KB-17, UC-16; FEAT-018
 * §3, §5.5; AC-1, AC-3, AC-4, AC-7, AC-10, AC-12).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { coachingKb, proposeCorrection, runStaleScan, type ProposalInput } from '@kaki/kb';
import { memoryRateLimiter } from '@kaki/platform';
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
let ownerId: string;
const limiter = memoryRateLimiter();
const SESSION = '00000000-0000-4000-8000-0000000000b1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { rateLimiter: limiter });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asStaff = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  await owner.query(
    `insert into coaching_sessions (tenant_id, id, created_by, origin) values ($1, $2, $3, 'coach')`,
    [TENANT_A, SESSION, ownerId],
  );
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, who: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload } : {}),
  });

async function product(name: string, price: string) {
  const res = await call('POST', '/api/v1/kb/facts', asA, {
    type: 'product',
    value: { name, price },
    gstTreatment: 'inclusive',
  });
  expect(res.statusCode).toBe(201);
  return res.json().fact as { id: string; version: number };
}

function propose(proposal: ProposalInput) {
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    proposeCorrection(coachingKb(tx, TENANT_A, ownerId, SESSION), { proposal }),
  );
}
const priceTo = (factId: string, name: string, priceCents: number): ProposalInput => ({
  kind: 'edit_fact',
  factId,
  patch: { value: { name, priceCents, currency: 'SGD' } },
});

/** A past visitor question whose agent reply cited `factId`, asked before now. */
async function pastQuestion(factId: string, name: string) {
  const conv = await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
    [TENANT_A],
  );
  const q = await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, created_at)
     values ($1, $2, 'visitor', $3, now() - interval '2 days') returning id`,
    [TENANT_A, conv.rows[0].id, `How much is the ${name}?`],
  );
  await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, in_reply_to, fact_ids, created_at)
     values ($1, $2, 'agent', 'It was the old price.', $3, array[$4::uuid], now() - interval '2 days' + interval '1 second')`,
    [TENANT_A, conv.rows[0].id, q.rows[0].id, factId],
  );
  return q.rows[0].id as string;
}

describe('who reaches the queue (AC-1)', () => {
  it('needs kb.manage and a session; tenant B sees none of A', async () => {
    const f = await product('Rose bandung cake', '30');
    const c = await propose(priceTo(f.id, 'Rose bandung cake', 3200));
    expect((await call('GET', '/api/v1/corrections', null)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/corrections', asStaff)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/kb/review-intervals', asStaff)).statusCode).toBe(403);
    const listB = await call('GET', '/api/v1/corrections', asB);
    expect(listB.json()).toEqual({ corrections: [], nextCursor: null });
    for (const [method, url] of [
      ['GET', `/api/v1/corrections/${c.id}`],
      ['POST', `/api/v1/corrections/${c.id}/accept`],
      ['POST', `/api/v1/corrections/${c.id}/close`],
      ['POST', `/api/v1/corrections/${c.id}/replay/next`],
      ['GET', '/api/v1/corrections/not-a-uuid'],
    ] as const) {
      const body = url.endsWith('/accept') ? { edit: null } : {};
      const res = await call(method, url, asB, method === 'POST' ? body : undefined);
      expect(res.statusCode, url).toBe(404);
    }
    expect((await call('GET', '/api/v1/corrections?status=bogus', asA)).json().error).toBe(
      'invalid_query',
    );
  });
});

describe('list and detail (AC-2, AC-10)', () => {
  it('lists open items with their facts and proposal, filters by source, shows the coaching context', async () => {
    const f = await product('Pandan chiffon', '28');
    await owner.query(
      `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body)
       values ($1, $2, 100, 'owner', 'question', 'The pandan chiffon is now $30') returning id`,
      [TENANT_A, SESSION],
    );
    const proposal = await owner.query(
      `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body)
       values ($1, $2, 101, 'agent', 'proposal', 'Change the pandan chiffon to S$30?') returning id`,
      [TENANT_A, SESSION],
    );
    const c = await propose(priceTo(f.id, 'Pandan chiffon', 3000));
    await owner.query(`update corrections set coaching_message_id = $2 where id = $1`, [
      c.id,
      proposal.rows[0].id,
    ]);

    const list = (await call('GET', '/api/v1/corrections', asA)).json();
    expect(list.corrections[0]).toMatchObject({
      id: c.id,
      status: 'open',
      source: 'coaching',
      proposedBy: 'coaching',
      change: { kind: 'edit_fact', after: { value: { price: '30.00' } } },
      facts: [{ id: f.id, label: 'Pandan chiffon', status: 'approved', overdue: false }],
      closedBySystem: false,
    });
    expect((await call('GET', '/api/v1/corrections?source=stale', asA)).json().corrections).toEqual(
      [],
    );
    const detail = (await call('GET', `/api/v1/corrections/${c.id}`, asA)).json();
    expect(detail.context).toEqual({
      coaching: {
        question: 'The pandan chiffon is now $30',
        proposal: 'Change the pandan chiffon to S$30?',
      },
      conversation: null,
    });
    expect(detail.replay).toBeNull();
    const summary = (await call('GET', '/api/v1/kb/review/summary', asA)).json();
    expect(summary.openCorrections).toBeGreaterThanOrEqual(2);
    expect(summary.overdueFacts).toBe(0);
  });
});

describe('accept, edit, close (AC-3, AC-4)', () => {
  it('accepts as proposed, then 409 correction_closed', async () => {
    const f = await product('Ondeh cake', '40');
    const c = await propose(priceTo(f.id, 'Ondeh cake', 4200));
    const res = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, { edit: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      correction: { status: 'accepted', acceptedChange: null },
      replay: null,
    });
    const fact = (await call('GET', `/api/v1/kb/facts/${f.id}`, asA)).json().fact;
    expect(fact).toMatchObject({ version: 2, value: { price: '42.00' } });
    const again = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, { edit: null });
    expect([again.statusCode, again.json().error]).toEqual([409, 'correction_closed']);
  });

  it('accepts an edited fix and keeps the proposal', async () => {
    const f = await product('Kaya roll', '12');
    const c = await propose(priceTo(f.id, 'Kaya roll', 1300));
    const res = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, {
      edit: {
        kind: 'edit_fact',
        after: {
          value: { name: 'Kaya roll', price: '13.50' },
          gstTreatment: 'inclusive',
          validFrom: null,
          validUntil: null,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().correction).toMatchObject({
      status: 'edited_and_accepted',
      change: { after: { value: { price: '13.00' } } },
      acceptedChange: { kind: 'edit_fact', after: { value: { price: '13.50' } } },
    });
    expect((await call('GET', `/api/v1/kb/facts/${f.id}`, asA)).json().fact.value.price).toBe(
      '13.50',
    );
  });

  it('422 for a no-op edit, an hours edit and a mismatched kind; 409 for a stale fact', async () => {
    const f = await product('Lapis legit', '60');
    const c = await propose(priceTo(f.id, 'Lapis legit', 6500));
    const noop = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, {
      edit: {
        kind: 'edit_fact',
        after: {
          value: { name: 'Lapis legit', price: '60' },
          gstTreatment: 'inclusive',
          validFrom: null,
          validUntil: null,
        },
      },
    });
    expect([noop.statusCode, noop.json().error]).toEqual([422, 'invalid_correction']);
    const kind = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, {
      edit: { kind: 'add_faq', question: 'Halal?', answer: 'Yes.' },
    });
    expect([kind.statusCode, kind.json().error]).toEqual([422, 'not_editable']);
    const hours = await propose({
      kind: 'edit_hours',
      profileVersion: 0,
      before: {},
      after: { mon: [{ open: '09:00', close: '17:00' }] },
    });
    const h = await call('POST', `/api/v1/corrections/${hours.id}/accept`, asA, {
      edit: { kind: 'add_faq', question: 'Open?', answer: 'Yes.' },
    });
    expect([h.statusCode, h.json().error]).toEqual([422, 'not_editable']);

    await owner.query(`update facts set version = version + 1 where id = $1`, [f.id]);
    const stale = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, { edit: null });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'correction_stale']);
  });

  it('closes with no change', async () => {
    const f = await product('Bika ambon', '25');
    const c = await propose(priceTo(f.id, 'Bika ambon', 2600));
    const res = await call('POST', `/api/v1/corrections/${c.id}/close`, asA, {});
    expect(res.json().correction).toMatchObject({ status: 'dismissed', closedBySystem: false });
    expect((await call('GET', `/api/v1/kb/facts/${f.id}`, asA)).json().fact.version).toBe(1);
    const closed = (await call('GET', '/api/v1/corrections?status=closed', asA)).json();
    expect(closed.corrections.map((x: { id: string }) => x.id)).toContain(c.id);
  });
});

describe('stale facts and review intervals (AC-5, AC-6)', () => {
  it('re-confirms a flagged fact in one call; intervals read and save', async () => {
    expect((await call('GET', '/api/v1/kb/review-intervals', asA)).json()).toEqual({
      intervals: { product: 6, faq: 6, policy: 6, promotion: 6 },
    });
    const bad = await call('PUT', '/api/v1/kb/review-intervals', asA, {
      intervals: { product: 0, faq: 6, policy: 6, promotion: 6 },
    });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'invalid_body']);
    const saved = await call('PUT', '/api/v1/kb/review-intervals', asA, {
      intervals: { product: 3, faq: 6, policy: 6, promotion: 6 },
    });
    expect(saved.json().intervals.product).toBe(3);

    const f = await product('Kueh dadar', '8');
    await owner.query(
      `update facts set last_confirmed_at = now() - interval '4 months' where id = $1`,
      [f.id],
    );
    await runStaleScan(tdb.zone('outbox'));
    expect((await call('GET', '/api/v1/kb/review/summary', asA)).json().overdueFacts).toBe(1);
    const list = (await call('GET', '/api/v1/corrections?source=stale', asA)).json();
    const item = list.corrections.find((x: { facts: { id: string }[] }) => x.facts[0]?.id === f.id);
    expect(item).toMatchObject({ change: { kind: 'reconfirm', factVersion: 1 } });
    const res = await call('POST', `/api/v1/corrections/${item.id}/accept`, asA, { edit: null });
    expect(res.json()).toMatchObject({ correction: { status: 'accepted' }, replay: null });
    expect((await call('GET', '/api/v1/kb/review/summary', asA)).json().overdueFacts).toBe(0);
  });
});

describe('the old-versus-new replay (AC-7, AC-12)', () => {
  it('starts on accept, answers one question per call within 8 s, then 409', async () => {
    const f = await product('Chocolate fudge cake', '55');
    const asked = [await pastQuestion(f.id, 'chocolate fudge cake')];
    asked.push(await pastQuestion(f.id, 'chocolate fudge cake'));
    const c = await propose(priceTo(f.id, 'Chocolate fudge cake', 6100));
    const res = await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, { edit: null });
    const replay = res.json().replay;
    expect(replay).toMatchObject({ status: 'replaying', matched: 2 });
    expect(replay.turns.map((t: { messageId: string }) => t.messageId)).toEqual(
      [...asked].reverse(),
    );
    const t0 = Date.now();
    const first = await call('POST', `/api/v1/corrections/${c.id}/replay/next`, asA, {});
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ remaining: 1, turn: { index: 0, status: 'done' } });
    expect(first.json().turn.replayed.text).toContain('61');
    expect(first.json().turn.original[0].text).toBe('It was the old price.');
    await call('POST', `/api/v1/corrections/${c.id}/replay/next`, asA, {});
    const done = await call('POST', `/api/v1/corrections/${c.id}/replay/next`, asA, {});
    expect([done.statusCode, done.json().error]).toEqual([409, 'replay_complete']);
    const detail = (await call('GET', `/api/v1/corrections/${c.id}`, asA)).json();
    expect(detail.replay.status).toBe('complete');

    // A correction replay is not a Coach session or a FEAT-028 replay.
    const { rows } = await owner.query(
      `select id from coaching_sessions where correction_id = $1`,
      [c.id],
    );
    expect((await call('GET', `/api/v1/coach/replays/${rows[0].id}`, asA)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/coach/sessions/${rows[0].id}`, asA)).statusCode).toBe(404);
    const sessions = (await call('GET', '/api/v1/coach/sessions', asA)).json().sessions;
    expect(sessions.map((s: { id: string }) => s.id)).not.toContain(rows[0].id);
  });

  it('starts lazily on the detail GET when the start failed, and the coach confirm starts it too', async () => {
    const f = await product('Black forest cake', '50');
    await pastQuestion(f.id, 'black forest cake');
    const c = await propose(priceTo(f.id, 'Black forest cake', 5200));
    await owner.query(
      `update corrections set status = 'accepted', decided_at = now(), decided_by = $2 where id = $1`,
      [c.id, ownerId],
    );
    const detail = (await call('GET', `/api/v1/corrections/${c.id}`, asA)).json();
    expect(detail.replay).toMatchObject({ matched: 1, status: 'replaying' });

    const g = await product('Swiss roll', '20');
    await pastQuestion(g.id, 'swiss roll');
    const d = await propose(priceTo(g.id, 'Swiss roll', 2200));
    const confirm = await call('POST', `/api/v1/coach/corrections/${d.id}/confirm`, asA, {});
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().replayQuestions).toBe(1);
  });

  it('404 with no replay; 429 past 30 replayed questions a minute', async () => {
    const faq = await propose({ kind: 'add_faq', question: 'Do you deliver?', answer: 'Yes.' });
    await call('POST', `/api/v1/corrections/${faq.id}/accept`, asA, { edit: null });
    expect(
      (await call('POST', `/api/v1/corrections/${faq.id}/replay/next`, asA, {})).statusCode,
    ).toBe(404);

    const f = await product('Durian puff', '4');
    await pastQuestion(f.id, 'durian puff');
    const c = await propose(priceTo(f.id, 'Durian puff', 450));
    await call('POST', `/api/v1/corrections/${c.id}/accept`, asA, { edit: null });
    for (let i = 0; i < 30; i++) await limiter.hit(`replay:${ownerId}`, 30, 60_000);
    const limited = await call('POST', `/api/v1/corrections/${c.id}/replay/next`, asA, {});
    expect([limited.statusCode, limited.json().error]).toEqual([429, 'rate_limited']);
  });
});
