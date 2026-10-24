/**
 * Old-versus-new replay after an accepted correction (KB-18, UC-16 4; FEAT-018 §5.4;
 * AC-7, AC-8, agent half), on the fake provider.
 */
import { randomUUID } from 'node:crypto';
import { usageSink } from '@kaki/analytics';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import {
  acceptCorrection,
  coachingKb,
  correctionFactInput,
  createFact,
  dashboardKb,
  dismissCorrection,
  prepareChunk,
  proposeCorrection,
  type FactInput,
  type ProposalInput,
} from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  correctionReplayNext,
  CorrectionReplayNotFoundError,
  fakeAgentScript,
  getCorrectionReplay,
  listSessions,
  ReplayCompleteError,
  runVisitorTurn,
  startCorrectionReplay,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const embedder = gatewayFromConfig({ provider: 'fake' });

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

const dash = () => tdb.zone('dashboard');
function gateway() {
  return createGateway(
    defaultRegistry('fake'),
    [createFakeProvider((req) => fakeAgentScript(req))],
    { onUsage: usageSink(dash(), { warn: () => {} }) },
  );
}
const deps = () => ({ zdb: dash(), llm: gateway() });

async function create(input: FactInput) {
  const chunk = await prepareChunk(embedder, TENANT_A, input);
  return (
    await withTenant(dash(), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, USER), input, chunk),
    )
  ).id;
}

/** A conversation whose visitor asked `text`, answered live by the agent. */
async function asked(text: string) {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  await runVisitorTurn(
    {
      zdb: tdb.zone('visitor'),
      llm: createGateway(defaultRegistry('fake'), [createFakeProvider(fakeAgentScript)]),
    },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
  return { conversationId: conv.id, messageId: message.id };
}

/** A conversation with a visitor question and a seeded agent reply citing `factId`. */
async function seeded(factId: string, at: string) {
  const conv = await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
    [TENANT_A],
  );
  const q = await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, created_at)
     values ($1, $2, 'visitor', 'How much is the chocolate fudge cake?', $3) returning id`,
    [TENANT_A, conv.rows[0].id, at],
  );
  await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, in_reply_to, fact_ids, created_at)
     values ($1, $2, 'agent', 'It is S$55.00.', $3, array[$4::uuid], $5::timestamptz + interval '1 second')`,
    [TENANT_A, conv.rows[0].id, q.rows[0].id, factId, at],
  );
  return { conversationId: conv.rows[0].id as string, messageId: q.rows[0].id as string };
}

function propose(proposal: ProposalInput) {
  return withTenant(dash(), TENANT_A, (tx) =>
    proposeCorrection(coachingKb(tx, TENANT_A, USER, SESSION), { proposal }),
  );
}
async function accept(proposal: ProposalInput) {
  const c = await propose(proposal);
  const input = correctionFactInput(c);
  const chunk = input ? await prepareChunk(embedder, TENANT_A, input) : undefined;
  return withTenant(dash(), TENANT_A, (tx) =>
    acceptCorrection(dashboardKb(tx, TENANT_A, USER), c.id, chunk ? { chunk } : {}),
  );
}
const price = (factId: string, priceCents: number): ProposalInput => ({
  kind: 'edit_fact',
  factId,
  patch: { value: { ...FUDGE.value, priceCents } as typeof FUDGE.value },
});

const start = (correctionId: string) =>
  startCorrectionReplay(deps(), { tenantId: TENANT_A, userId: USER, correctionId });
const next = (correctionId: string) =>
  correctionReplayNext(deps(), { tenantId: TENANT_A, userId: USER, correctionId });

async function count(sql: string, params: unknown[] = []) {
  return Number((await owner.query(sql, params)).rows[0].count);
}

let fudge: string;
const old: { conversationId: string; messageId: string }[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(
    `insert into coaching_sessions (tenant_id, id, created_by, origin) values ($1, $2, $3, 'coach')`,
    [TENANT_A, SESSION, USER],
  );
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
  fudge = await create(FUDGE);
  // 24 older questions (seeded replies) and the newest one answered live.
  for (let i = 0; i < 24; i++)
    old.push(await seeded(fudge, new Date(Date.now() - (30 - i) * 86_400_000).toISOString()));
  old.push(await asked('How much is the chocolate fudge cake?'));
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('a correction replay (AC-7)', () => {
  let correctionId: string;

  it('holds the newest 20 of 25 questions that used the fact, all pending', async () => {
    const live = await owner.query(`select fact_ids from messages where in_reply_to = $1`, [
      old.at(-1)!.messageId,
    ]);
    expect(live.rows[0].fact_ids).toEqual([fudge]);
    const c = await accept(price(fudge, 6100));
    correctionId = c.id;
    // A question asked after acceptance is not part of it (D4).
    await seeded(fudge, new Date(Date.now() + 60_000).toISOString());

    const r = await start(c.id);
    expect(r).not.toBeNull();
    expect(r!.matched).toBe(25);
    expect(r!.status).toBe('replaying');
    expect(r!.turns.map((t) => t.messageId)).toEqual(
      old
        .slice(-20)
        .reverse()
        .map((q) => q.messageId),
    );
    expect(r!.turns.every((t) => t.replayed === null && t.answerChanged === null)).toBe(true);
    expect(r!.turns[0]!.original[0]).toMatchObject({ author: 'agent', factIds: [fudge] });
    // Idempotent: the same session, no second audit entry.
    const again = await start(c.id);
    expect(again!.session.id).toBe(r!.session.id);
    expect(
      await count(
        `select count(*) from audit_entries where event_type = 'correction.replay.started'`,
      ),
    ).toBe(1);
  });

  it('answers one question per call, in order, with the new value next to the old reply', async () => {
    const first = await next(correctionId);
    expect(first.remaining).toBe(19);
    expect(first.turn.index).toBe(0);
    expect(first.turn.replayed!.body).toContain('61');
    expect(first.turn.original[0]!.text).not.toContain('61');
    expect(first.turn.answerChanged).toBe(true);
    const second = await next(correctionId);
    expect(second.turn.index).toBe(1);
    expect(second.remaining).toBe(18);
  });

  it('writes no conversation, message or outbox rows; usage carries the session', async () => {
    const before = {
      conversations: await count(`select count(*) from conversations`),
      messages: await count(`select count(*) from messages`),
      outbox: await count(`select count(*) from outbox`),
    };
    const { turn } = await next(correctionId);
    expect(turn.replayed).not.toBeNull();
    expect({
      conversations: await count(`select count(*) from conversations`),
      messages: await count(`select count(*) from messages`),
      outbox: await count(`select count(*) from outbox`),
    }).toEqual(before);
    const view = await getCorrectionReplay(deps(), { tenantId: TENANT_A, correctionId });
    const usage = (
      await owner.query(`select conversation_id from usage_events where coaching_session_id = $1`, [
        view!.session.id,
      ])
    ).rows;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.conversation_id === null)).toBe(true);
    // Visitor text is read from messages, never stored in coaching_* (ADR-009).
    expect(
      await count(
        `select count(*) from coaching_messages where session_id = $1 and body like '%chocolate fudge cake?%'`,
        [view!.session.id],
      ),
    ).toBe(0);
    // Not a Coach session.
    const sessions = await withTenant(dash(), TENANT_A, (tx) => listSessions(tx, TENANT_A));
    expect(sessions.sessions.map((s) => s.id)).not.toContain(view!.session.id);
  });

  it('drops a question whose conversation is deleted, with its replayed answer', async () => {
    const view = (await getCorrectionReplay(deps(), { tenantId: TENANT_A, correctionId }))!;
    const gone = view.turns[0]!;
    await owner.query(`delete from messages where conversation_id = $1`, [gone.conversationId]);
    await owner.query(`delete from conversations where id = $1`, [gone.conversationId]);
    const after = (await getCorrectionReplay(deps(), { tenantId: TENANT_A, correctionId }))!;
    expect(after.turns).toHaveLength(19);
    expect(after.turns.map((t) => t.messageId)).not.toContain(gone.messageId);
    expect(
      await count(`select count(*) from coaching_messages where replay_of = $1`, [gone.messageId]),
    ).toBe(0);
  });

  it('reports complete after the last question', async () => {
    for (;;) {
      const { remaining } = await next(correctionId);
      if (remaining === 0) break;
    }
    const view = await getCorrectionReplay(deps(), { tenantId: TENANT_A, correctionId });
    expect(view!.status).toBe('complete');
    await expect(next(correctionId)).rejects.toBeInstanceOf(ReplayCompleteError);
  }, 60_000);
});

describe('what does not replay (D3)', () => {
  it('a new FAQ, an hours change, a re-confirm and an open or closed item have none', async () => {
    const faq = await accept({ kind: 'add_faq', question: 'Do you deliver?', answer: 'Yes.' });
    expect(await start(faq.id)).toBeNull();
    const hours = await propose({
      kind: 'edit_hours',
      profileVersion: 0,
      before: {},
      after: { mon: [{ open: '09:00', close: '17:00' }] },
    });
    await owner.query(
      `update corrections set status = 'accepted', decided_at = now() where id = $1`,
      [hours.id],
    );
    expect(await start(hours.id)).toBeNull();
    const reconfirm = await owner.query(
      `insert into corrections (tenant_id, source_type, proposed_by, fact_refs, proposed_change, status, decided_at)
       values ($1, 'stale', 'system', array[$2::uuid], $3, 'accepted', now()) returning id`,
      [
        TENANT_A,
        fudge,
        {
          kind: 'reconfirm',
          factId: fudge,
          factVersion: 2,
          factType: 'product',
          label: 'x',
          lastConfirmedAt: new Date().toISOString(),
        },
      ],
    );
    expect(await start(reconfirm.rows[0].id)).toBeNull();
    const open = await propose(price(fudge, 6300));
    expect(await start(open.id)).toBeNull();
    await withTenant(dash(), TENANT_A, (tx) =>
      dismissCorrection(dashboardKb(tx, TENANT_A, USER), open.id),
    );
    expect(await start(open.id)).toBeNull();
    await expect(next(open.id)).rejects.toBeInstanceOf(CorrectionReplayNotFoundError);
  });
});
