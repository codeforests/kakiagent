/**
 * Coaching endpoints on the fake provider (AGT-17, ONB-05; FEAT-027 §3, §5.5; AC-1,
 * AC-6, AC-7, AC-8, AC-9, AC-15).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { searchVisitorFacts, visitorKb } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
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
let fudge: string;
const embedder = gatewayFromConfig({ provider: 'fake' });
const CONV = '00000000-0000-4000-8000-00000000c0de';

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
  await owner.query(
    `insert into business_profiles (tenant_id, industry) values ($1, 'fnb')
     on conflict (tenant_id) do update set industry = 'fnb'`,
    [TENANT_A],
  );
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asStaff = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  const res = await call('POST', '/api/v1/kb/facts', asA, {
    type: 'product',
    value: { name: 'Chocolate fudge cake', price: '55', unit: '1 kg' },
    gstTreatment: 'inclusive',
  });
  fudge = res.json().fact.id;
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const call = (method: 'GET' | 'POST', url: string, who: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload } : {}),
  });

async function newSession(who = asA, origin = 'coach') {
  const res = await call('POST', '/api/v1/coach/sessions', who, { origin });
  expect(res.statusCode).toBe(201);
  return res.json().session.id as string;
}

const ask = (id: string, text: string, includeUnreviewed = false, who = asA) =>
  call('POST', `/api/v1/coach/sessions/${id}/messages`, who, { text, includeUnreviewed });

async function visitorPrice(): Promise<unknown> {
  const { vectors } = await embedder.embed({
    texts: ['chocolate fudge cake price'],
    purpose: 'query',
    meta: { tenantId: TENANT_A },
  });
  const hits = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    searchVisitorFacts(visitorKb(tx, TENANT_A, CONV), vectors[0]!),
  );
  const hit = hits.find((h) => h.id === fudge) as { value: { priceCents?: number } } | undefined;
  return hit?.value.priceCents;
}

describe('access (AC-1)', () => {
  it('refuses staff with 403 and no session with 401 on every route', async () => {
    const id = await newSession();
    const routes: ['GET' | 'POST', string, unknown?][] = [
      ['POST', '/api/v1/coach/sessions', { origin: 'coach' }],
      ['GET', '/api/v1/coach/sessions'],
      ['GET', `/api/v1/coach/sessions/${id}`],
      ['POST', `/api/v1/coach/sessions/${id}/messages`, { text: 'hi', includeUnreviewed: false }],
      ['POST', `/api/v1/coach/corrections/${CONV}/confirm`, {}],
      ['POST', `/api/v1/coach/corrections/${CONV}/dismiss`, {}],
      ['GET', '/api/v1/coach/suggestions'],
    ];
    for (const [m, url, body] of routes) {
      const staff = await call(m, url, asStaff, body);
      expect(staff.statusCode, url).toBe(403);
      expect(staff.json().error).toBe('forbidden');
      expect((await call(m, url, null, body)).statusCode, url).toBe(401);
    }
  });

  it("gives tenant B 404 for tenant A's sessions and corrections, and for malformed IDs", async () => {
    const id = await newSession();
    await ask(id, 'How much is the chocolate fudge cake?');
    const p = await ask(id, 'Chocolate fudge cake went up to $58');
    const correction = p.json().answer.correction.id;
    expect((await call('GET', `/api/v1/coach/sessions/${id}`, asB)).statusCode).toBe(404);
    expect((await ask(id, 'hello', false, asB)).statusCode).toBe(404);
    for (const action of ['confirm', 'dismiss']) {
      const res = await call('POST', `/api/v1/coach/corrections/${correction}/${action}`, asB, {});
      expect(res.statusCode).toBe(404);
    }
    expect((await call('GET', '/api/v1/coach/sessions/nope', asA)).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/coach/corrections/nope/confirm', asA, {})).statusCode).toBe(
      404,
    );
    const listB = (await call('GET', '/api/v1/coach/sessions', asB)).json();
    expect(listB.sessions.map((s: { id: string }) => s.id)).not.toContain(id);
    // Still open: tenant B's attempts changed nothing.
    const { rows } = await owner.query(`select status from corrections where id = $1`, [
      correction,
    ]);
    expect(rows[0].status).toBe('open');
    await call('POST', `/api/v1/coach/corrections/${correction}/dismiss`, asA, {});
  });
});

describe('sessions', () => {
  it('creates, lists newest first and reads a session with its messages', async () => {
    const first = await newSession(asA, 'setup');
    const second = await newSession(asA, 'panel');
    const list = (await call('GET', '/api/v1/coach/sessions', asA)).json();
    const ids = list.sessions.map((s: { id: string }) => s.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    const turn = await ask(first, '  How much is the chocolate fudge cake?  ');
    expect(turn.statusCode).toBe(201);
    const detail = (await call('GET', `/api/v1/coach/sessions/${first}`, asA)).json();
    expect(detail.session).toMatchObject({
      id: first,
      origin: 'setup',
      title: 'How much is the chocolate fudge cake?',
    });
    expect(detail.messages.map((m: { kind: string }) => m.kind)).toEqual(['question', 'answer']);
    const top = (await call('GET', '/api/v1/coach/sessions', asA)).json().sessions[0];
    expect(top.id).toBe(first);
  });

  it('rejects a bad origin, an empty or long text, and a bad cursor', async () => {
    expect((await call('POST', '/api/v1/coach/sessions', asA, { origin: 'x' })).statusCode).toBe(
      422,
    );
    const id = await newSession();
    for (const text of ['   ', 'x'.repeat(1001)]) {
      const res = await ask(id, text);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('invalid_body');
    }
    const noFlag = await call('POST', `/api/v1/coach/sessions/${id}/messages`, asA, { text: 'hi' });
    expect(noFlag.statusCode).toBe(422);
    expect((await call('GET', '/api/v1/coach/sessions?cursor=zzz', asA)).statusCode).toBe(400);
  });
});

describe('a turn (AC-2, AC-8, AC-15)', () => {
  it('answers with the explainer within the 8 s bound and writes no conversation rows', async () => {
    const id = await newSession();
    const count = async () =>
      (
        await owner.query(
          `select (select count(*) from conversations)::int as c, (select count(*) from messages)::int as m,
                  (select count(*) from outbox)::int as o`,
        )
      ).rows[0];
    const before = await count();
    const started = Date.now();
    const res = await ask(id, 'How much is the chocolate fudge cake?');
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(201);
    expect(elapsed).toBeLessThan(8000);
    const { question, answer } = res.json();
    expect(question).toMatchObject({ author: 'owner', kind: 'question', seq: 1 });
    expect(answer).toMatchObject({ author: 'agent', kind: 'answer', correction: null });
    expect(answer.text).toContain('$55.00');
    expect(answer.explainer).toMatchObject({
      outcome: 'answered',
      usedFactIds: [fudge],
      visitorsWouldGet: 'same',
    });
    expect(answer.explainer.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fudge, type: 'product', status: 'approved', used: true }),
      ]),
    );
    expect(await count()).toEqual(before);
  });

  it('is refused with 429 after 20 turns a minute for the same user', async () => {
    const limited = await testApp(tdb);
    try {
      const id = await newSession();
      const turn = () =>
        limited.inject({
          method: 'POST',
          url: `/api/v1/coach/sessions/${id}/messages`,
          headers: { cookie: asA },
          payload: { text: 'Hello', includeUnreviewed: false },
        });
      for (let i = 0; i < 20; i++) expect((await turn()).statusCode).toBe(201);
      const res = await turn();
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });
});

describe('corrections (AC-6, AC-7, AC-9)', () => {
  async function propose(price = '58') {
    const id = await newSession();
    await ask(id, 'How much is the chocolate fudge cake?');
    const res = await ask(id, `Chocolate fudge cake went up to $${price}`);
    expect(res.statusCode).toBe(201);
    return res.json().answer;
  }

  it('proposes, then a confirm makes visitors see the new price, with before and after', async () => {
    const proposal = await propose();
    expect(proposal).toMatchObject({
      kind: 'proposal',
      explainer: null,
      correction: {
        status: 'open',
        decidedAt: null,
        change: {
          kind: 'edit_fact',
          factId: fudge,
          factType: 'product',
          before: { value: { name: 'Chocolate fudge cake', price: '55.00' } },
          after: { value: { price: '58.00' } },
        },
      },
    });
    expect(await visitorPrice()).toBe(5500);
    const res = await call(
      'POST',
      `/api/v1/coach/corrections/${proposal.correction.id}/confirm`,
      asA,
      {},
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.correction).toMatchObject({ status: 'accepted' });
    expect(body.correction.decidedAt).not.toBeNull();
    expect(body.before.text).toContain('$55.00');
    expect(body.after).toMatchObject({ kind: 'after' });
    expect(body.after.text).toContain('$58.00');
    expect(await visitorPrice()).toBe(5800);
    const audit = await owner.query(
      `select event_type, payload::text as p from audit_entries
       where tenant_id = $1 and event_type in ('correction.accepted', 'coach.turn', 'coach.reanswer')`,
      [TENANT_A],
    );
    expect(audit.rows.map((r) => r.event_type)).toContain('correction.accepted');
    for (const r of audit.rows) expect(r.p).not.toMatch(/fudge|58/i);

    const again = await call(
      'POST',
      `/api/v1/coach/corrections/${proposal.correction.id}/confirm`,
      asA,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('correction_closed');
  });

  it('dismisses with no fact change; deciding twice is correction_closed', async () => {
    const proposal = await propose('60');
    const price = await visitorPrice();
    const url = `/api/v1/coach/corrections/${proposal.correction.id}`;
    const res = await call('POST', `${url}/dismiss`, asA, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().correction).toMatchObject({ status: 'dismissed' });
    expect(await visitorPrice()).toBe(price);
    for (const action of ['dismiss', 'confirm']) {
      const r = await call('POST', `${url}/${action}`, asA, {});
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('correction_closed');
    }
  });

  it('is correction_stale when the fact changed since the proposal, and changes nothing', async () => {
    const proposal = await propose('62');
    const { fact } = (await call('GET', `/api/v1/kb/facts/${fudge}`, asA)).json();
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/kb/facts/${fudge}`,
      headers: { cookie: asA },
      payload: { version: fact.version, value: { ...fact.value, unit: '1.5 kg' } },
    });
    expect(edit.statusCode).toBe(200);
    const res = await call(
      'POST',
      `/api/v1/coach/corrections/${proposal.correction.id}/confirm`,
      asA,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('correction_stale');
    const { rows } = await owner.query(`select status from corrections where id = $1`, [
      proposal.correction.id,
    ]);
    expect(rows[0].status).toBe('open');
    const now = (await call('GET', `/api/v1/kb/facts/${fudge}`, asA)).json().fact;
    expect(now.version).toBe(fact.version + 1);
  });

  it('confirms an hours change through the business profile (AC-12)', async () => {
    const id = await newSession();
    const res = await ask(id, "We're open 9am to 5pm on weekends now");
    const { correction } = res.json().answer;
    expect(correction.change).toMatchObject({
      kind: 'edit_hours',
      after: { sat: [{ open: '09:00', close: '17:00' }], sun: [{ open: '09:00', close: '17:00' }] },
    });
    const done = await call('POST', `/api/v1/coach/corrections/${correction.id}/confirm`, asA, {});
    expect(done.statusCode).toBe(200);
    const { rows } = await owner.query(`select hours from business_profiles where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(rows[0].hours.sat).toEqual([{ open: '09:00', close: '17:00' }]);
  });
});

describe('suggestions', () => {
  it('offers template questions and the newest products, at most 6', async () => {
    const res = await call('GET', '/api/v1/coach/suggestions', asA);
    expect(res.statusCode).toBe(200);
    const { questions } = res.json();
    expect(questions.length).toBeLessThanOrEqual(6);
    expect(questions).toContain('Do you take custom cake orders?');
    expect(questions).toContain('How much is Chocolate fudge cake?');
    expect((await call('GET', '/api/v1/coach/suggestions', asB)).json().questions).not.toContain(
      'How much is Chocolate fudge cake?',
    );
  });
});
