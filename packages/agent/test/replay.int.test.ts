/**
 * Replay through the real pipeline on the fake provider (AGT-17, UC-04 4b; FEAT-028
 * §5.1, §5.2; AC-2–AC-9).
 */
import { randomUUID } from 'node:crypto';
import { usageSink } from '@kaki/analytics';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation, getMessage } from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk, type FactInput } from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationGoneError,
  fakeAgentScript,
  getReplay,
  NothingToReplayError,
  replayCandidates,
  ReplayCompleteError,
  ReplayConversationNotFoundError,
  replayNext,
  runVisitorTurn,
  startReplay,
  textsFor,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
const embedder = gatewayFromConfig({ provider: 'fake' });
let fudge: string;
let tart: string;

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
const TART: FactInput = {
  type: 'product',
  value: { name: 'Lemon tart', priceCents: 900, currency: 'SGD' },
  gstTreatment: 'inclusive',
};

async function create(input: FactInput) {
  const chunk = await prepareChunk(embedder, TENANT_A, input);
  return (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, USER), input, chunk),
    )
  ).id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  fudge = await create(FUDGE);
  tart = await create(TART);
  await owner.query(`update facts set status = 'needs_review' where id = $1`, [tart]);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`update tenants set ai_paused = false`);
  await owner.query(
    `update facts set value = jsonb_set(value, '{priceCents}', '5500') where id = $1`,
    [fudge],
  );
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});

function gateway() {
  return createGateway(
    defaultRegistry('fake'),
    [createFakeProvider((req) => fakeAgentScript(req))],
    { onUsage: usageSink(tdb.zone('dashboard'), { warn: () => {} }) },
  );
}
const deps = () => ({ zdb: tdb.zone('dashboard'), llm: gateway() });

async function conversation(...questions: string[]) {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  const ids: string[] = [];
  for (const text of questions) ids.push(await post(conv.id, visitorId, text));
  return { conversationId: conv.id, visitorId, ids };
}

async function post(conversationId: string, visitorId: string, text: string) {
  const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId,
      visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  return message.id;
}

/** The live turn, as the agent-worker runs it. */
async function live(conversationId: string, messageId: string) {
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => fakeAgentScript(req)),
  ]);
  return runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm },
    { tenantId: TENANT_A, conversationId, messageId },
  );
}

const start = (conversationId: string, includeUnreviewed = false) =>
  startReplay(deps(), { tenantId: TENANT_A, userId: USER, conversationId, includeUnreviewed });
const next = (sessionId: string) =>
  replayNext(deps(), { tenantId: TENANT_A, userId: USER, sessionId });

async function count(sql: string, params: unknown[] = []) {
  return Number((await owner.query(sql, params)).rows[0].count);
}

describe('a replayed question (AC-3, AC-4)', () => {
  it('equals the reply a live visitor turn gives for the same KB and history', async () => {
    const c = await conversation('How much is the chocolate fudge cake?');
    const reply = (await live(c.conversationId, c.ids[0]!))!;
    const r = await start(c.conversationId);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.original).toEqual([
      expect.objectContaining({ author: 'agent', text: reply.message.body, factIds: [fudge] }),
    ]);
    const { turn, remaining } = await next(r.session.id);
    expect(remaining).toBe(0);
    expect(turn.replayed).toMatchObject({
      kind: 'replay',
      author: 'agent',
      body: reply.message.body,
      outcome: reply.outcome,
      factIds: reply.message.factIds,
      replayOf: c.ids[0],
    });
    expect(turn.factsChanged).toBe(false);
  });

  it('renders a changed fact’s new value, next to what the visitor got', async () => {
    const c = await conversation('How much is the chocolate fudge cake?');
    await live(c.conversationId, c.ids[0]!);
    await owner.query(
      `update facts set value = jsonb_set(value, '{priceCents}', '6200') where id = $1`,
      [fudge],
    );
    const r = await start(c.conversationId);
    const { turn } = await next(r.session.id);
    expect(turn.original[0]!.text).toContain('$55.00');
    expect(turn.replayed!.body).toContain('$62.00');
    expect(turn.replayed!.explainer).toMatchObject({
      outcome: 'answered',
      usedFactIds: [fudge],
      reasons: expect.arrayContaining(['matched_facts']),
    });
  });

  it('uses unreviewed facts only when the replay includes them, and labels them', async () => {
    const c = await conversation('How much is the lemon tart?');
    const without = await next((await start(c.conversationId, false)).session.id);
    expect(without.turn.replayed!.factIds).not.toContain(tart);
    const withIt = await next((await start(c.conversationId, true)).session.id);
    expect(withIt.turn.replayed!.factIds).toContain(tart);
    expect(withIt.turn.replayed!.explainer).toMatchObject({
      reasons: expect.arrayContaining(['unreviewed_used']),
    });
    // No original agent reply: nothing to compare.
    expect(withIt.turn.factsChanged).toBeNull();
  });
});

describe('safety tasks replay as they would live, writing nothing (AC-5)', () => {
  it('a crisis question gives the crisis text and effect, and no flag', async () => {
    const c = await conversation('I want to die');
    const r = await start(c.conversationId);
    const { turn } = await next(r.session.id);
    expect(turn.replayed!.body).toBe(textsFor('en').crisis);
    expect(turn.replayed!.outcome).toBe('ended');
    expect(turn.effects).toEqual([{ task: 'crisis', outcome: 'done' }]);
    expect(turn.replayed!.explainer).toMatchObject({
      outcome: 'ended',
      reasons: expect.arrayContaining(['crisis']),
    });
    const row = (
      await owner.query(`select flag_reasons, flagged_at from conversations where id = $1`, [
        c.conversationId,
      ])
    ).rows[0];
    expect(row).toEqual({ flag_reasons: [], flagged_at: null });
  });

  it('repeated abuse warns, then ends, and the conversation is unchanged', async () => {
    const c = await conversation('you stupid bot', 'shut up you idiot');
    const r = await start(c.conversationId);
    const first = await next(r.session.id);
    const second = await next(r.session.id);
    expect(first.turn.effects).toEqual([{ task: 'abuse', outcome: 'done' }]);
    expect(first.turn.replayed!.explainer).toMatchObject({
      reasons: expect.arrayContaining(['abuse_warning']),
    });
    expect(second.turn.replayed!.explainer).toMatchObject({
      reasons: expect.arrayContaining(['abuse_ended']),
    });
    expect(second.turn.replayed!.body).toBe(textsFor('en').abuseEnded);
    const row = (
      await owner.query(
        `select status, flag_reasons, abuse_turns from conversations where id = $1`,
        [c.conversationId],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'ai', flag_reasons: [], abuse_turns: [] });
  });
});

describe('what a replay writes (AC-6, AC-8, AC-9)', () => {
  it('no conversation, message or outbox rows; usage on the coaching session', async () => {
    const question = 'How much is the chocolate fudge cake for Mei Ling at 9123 4567?';
    const c = await conversation(question);
    const before = {
      conversations: await count(`select count(*) from conversations`),
      messages: await count(`select count(*) from messages`),
      outbox: await count(`select count(*) from outbox`),
    };
    const r = await start(c.conversationId);
    await next(r.session.id);
    expect({
      conversations: await count(`select count(*) from conversations`),
      messages: await count(`select count(*) from messages`),
      outbox: await count(`select count(*) from outbox`),
    }).toEqual(before);
    const usage = (
      await owner.query(
        `select conversation_id, coaching_session_id from usage_events where coaching_session_id = $1`,
        [r.session.id],
      )
    ).rows;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.conversation_id === null)).toBe(true);

    // D7: the visitor's text is read from messages, never copied into coaching.
    const stored = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      getMessage(tx, TENANT_A, c.ids[0]!),
    );
    expect(
      await count(
        `select count(*) from coaching_sessions s left join coaching_messages m
           on m.tenant_id = s.tenant_id and m.session_id = s.id
         where s.id = $1 and (s.title = $2 or m.body like '%' || $2 || '%')`,
        [r.session.id, stored!.body],
      ),
    ).toBe(0);
    expect(r.session.title).toBeNull();

    // AC-9: one entry to start, one per question, codes and IDs only.
    const { rows } = await owner.query(
      `select event_type, payload::text as payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [r.session.id],
    );
    expect(rows.map((e) => e.event_type)).toEqual(['coach.replay.started', 'coach.replay.turn']);
    for (const e of rows) {
      expect(e.payload).not.toContain('Mei Ling');
      expect(e.payload).not.toContain('chocolate');
    }
  });

  it('is deleted with its conversation', async () => {
    const c = await conversation('How much is the chocolate fudge cake?');
    const r = await start(c.conversationId);
    await next(r.session.id);
    await owner.query(`delete from messages where conversation_id = $1`, [c.conversationId]);
    await expect(next(r.session.id)).rejects.toBeInstanceOf(ConversationGoneError);
    await owner.query(`delete from conversations where id = $1`, [c.conversationId]);
    expect(
      await count(`select count(*) from coaching_sessions where id = $1`, [r.session.id]),
    ).toBe(0);
    expect(
      await count(`select count(*) from coaching_messages where session_id = $1`, [r.session.id]),
    ).toBe(0);
  });
});

describe('turns and candidates (AC-2, AC-7)', () => {
  it('answers in order, one per call, then reports complete', async () => {
    const c = await conversation('How much is the chocolate fudge cake?', 'And the lemon tart?');
    const r = await start(c.conversationId);
    expect(r.turns.map((t) => t.replayed)).toEqual([null, null]);
    const a = await next(r.session.id);
    expect([a.turn.index, a.remaining]).toEqual([0, 1]);
    const b = await next(r.session.id);
    expect([b.turn.index, b.remaining]).toEqual([1, 0]);
    await expect(next(r.session.id)).rejects.toBeInstanceOf(ReplayCompleteError);
  });

  it('two concurrent calls store one answer', async () => {
    const c = await conversation('How much is the chocolate fudge cake?');
    const r = await start(c.conversationId);
    const [a, b] = await Promise.all([next(r.session.id), next(r.session.id)]);
    expect(a.turn.replayed!.id).toBe(b.turn.replayed!.id);
    expect(
      await count(`select count(*) from coaching_messages where session_id = $1`, [r.session.id]),
    ).toBe(1);
  });

  it('replays the first 20 of 34 questions', async () => {
    const qs = Array.from({ length: 34 }, (_, i) => `Question number ${i + 1} about cakes`);
    const c = await conversation(...qs);
    const r = await start(c.conversationId);
    expect(r.turns).toHaveLength(20);
    expect(r.totalQuestions).toBe(34);
    expect(r.turns[19]!.question).toBe('Question number 20 about cakes');
    const again = await getReplay(deps(), { tenantId: TENANT_A, sessionId: r.session.id });
    expect(again.turns).toHaveLength(20);
  });

  it('lists only conversations with a visitor message, newest first, with the last replay', async () => {
    const empty = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    const older = await conversation('Do you deliver?', 'How much is the lemon tart?');
    const newer = await conversation('What time do you open?');
    const r = await start(older.conversationId);
    const page = await replayCandidates(deps(), { tenantId: TENANT_A });
    const ids = page.conversations.map((x) => x.conversation.id);
    expect(ids).not.toContain(empty.id);
    expect(ids.indexOf(newer.conversationId)).toBeLessThan(ids.indexOf(older.conversationId));
    expect(
      page.conversations.find((x) => x.conversation.id === older.conversationId),
    ).toMatchObject({ firstQuestion: 'Do you deliver?', questions: 2, lastReplayId: r.session.id });
  });

  it('refuses a missing conversation and one with nothing to replay', async () => {
    await expect(start(randomUUID())).rejects.toBeInstanceOf(ReplayConversationNotFoundError);
    const empty = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    await expect(start(empty.id)).rejects.toBeInstanceOf(NothingToReplayError);
  });
});
