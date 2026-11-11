/**
 * FEAT-026 through the real turn and the summarise job (§5.3, §5.4; AC-1–AC-4, AC-7, AC-10):
 * a short chat folds nothing; the reply that brings 20 messages unfolded enqueues a fold on the
 * conversation's memory group; the job folds all but the last 10 once, idempotently; the next
 * turn's prompts carry the memory; a conversation moved to Telegram keeps it.
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type GenerateRequest,
  type UsageEvent,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fakeAgentScript,
  loadConversationHistory,
  runSummariseJob,
  runVisitorTurn,
  SUMMARY_SYSTEM,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
  // Telegram live with a bot, for the moved conversation (AC-7).
  const c = await owner.query<{ id: string }>(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
     values ($1, 'telegram', 'live', 'hidden', 'ok') returning id`,
    [TENANT_A],
  );
  await owner.query(
    `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name, webhook_secret_hash)
     values ($1, $2, 4243, 'kaki_memory_bot', 'Kaki Bakery', $3)`,
    [TENANT_A, c.rows[0]!.id, Buffer.alloc(32)],
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const requests: GenerateRequest[] = [];
const usage: UsageEvent[] = [];
const llm = createGateway(
  defaultRegistry('fake'),
  [
    createFakeProvider((req) => {
      requests.push(req);
      return fakeAgentScript(req);
    }),
  ],
  {
    onUsage: async (e) => {
      usage.push(e);
    },
  },
);
const visitor = () => tdb.zone('visitor');
const withTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(visitor(), TENANT_A, fn);

async function conversation() {
  const visitorId = randomUUID();
  const conv = await withTx((tx) => createConversation(tx, TENANT_A, visitorId));
  return { id: conv.id, visitorId };
}

async function say(conv: { id: string; visitorId: string }, text: string) {
  const { message } = await withTx((tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId: conv.visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  return runVisitorTurn(
    { zdb: visitor(), llm, clock: () => new Date('2026-11-04T03:00:00Z') },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
}

const jobs = async (conversationId: string) =>
  (
    await owner.query<{ group_key: string; payload: Record<string, unknown> }>(
      `select group_key, payload from outbox where payload->>'kind' = 'summarise' and payload->>'conversationId' = $1`,
      [conversationId],
    )
  ).rows;
const memories = async (conversationId: string) =>
  (
    await owner.query<{
      upto_seq: string;
      memory: Record<string, unknown>;
      messages_folded: number;
    }>(
      `select upto_seq, memory, messages_folded from conversation_summaries where conversation_id = $1 order by upto_seq`,
      [conversationId],
    )
  ).rows;
const seqs = async (conversationId: string) =>
  (
    await owner.query<{ seq: string }>(
      `select seq from messages where conversation_id = $1 order by seq`,
      [conversationId],
    )
  ).rows.map((r) => Number(r.seq));

const OPENING = "Hi, I'm Siti. I need 40 boxes of pineapple tarts for 14 Dec";
const FILLER = 'what time do you open';

/** Turns until the chat has at least `messages` messages. */
async function chat(conv: { id: string; visitorId: string }, messages: number) {
  await say(conv, OPENING);
  while ((await seqs(conv.id)).length < messages) await say(conv, FILLER);
}

describe('conversation memory (FEAT-026)', () => {
  it('AC-1: a short chat sends everything verbatim, enqueues and stores nothing', async () => {
    const conv = await conversation();
    await chat(conv, 12);
    expect(await jobs(conv.id)).toEqual([]);
    expect(await memories(conv.id)).toEqual([]);
    expect(requests.some((r) => r.system === SUMMARY_SYSTEM)).toBe(false);
    const all = await seqs(conv.id);
    const h = await withTx((tx) =>
      loadConversationHistory(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        upToSeq: all.at(-1)!,
      }),
    );
    expect(h).toMatchObject({ memory: null, unfolded: all.length });
    expect(h.messages.map((m) => m.seq)).toEqual(all);
  });

  it('AC-2, AC-3, AC-10: the 20th message enqueues a fold; the job folds all but the last 10, once', async () => {
    const conv = await conversation();
    await chat(conv, 20);
    const queued = await jobs(conv.id);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued[0]).toEqual({
      group_key: `memory:${conv.id}`,
      payload: { kind: 'summarise', tenantId: TENANT_A, conversationId: conv.id },
    });
    const all = await seqs(conv.id);
    const before = usage.length;
    const job = { kind: 'summarise' as const, tenantId: TENANT_A, conversationId: conv.id };
    // A provider failure writes nothing.
    const down = createGateway(defaultRegistry('fake'), [
      createFakeProvider(() => {
        throw new Error('down');
      }),
    ]);
    expect(await runSummariseJob({ llm: down, withTx }, job)).toEqual({
      outcome: 'failed',
      folded: 0,
    });
    expect(await memories(conv.id)).toEqual([]);

    expect(await runSummariseJob({ llm, withTx }, job)).toEqual({
      outcome: 'saved',
      folded: all.length - 10,
    });
    const rows = await memories(conv.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.upto_seq)).toBe(all.at(-11));
    expect(rows[0]!.memory).toMatchObject({
      visitorName: 'Siti',
      items: [{ what: 'boxes of pineapple tarts', quantity: '40' }],
      dates: ['14 Dec'],
    });
    // A duplicate job: nothing is due any more.
    expect(await runSummariseJob({ llm, withTx }, job)).toEqual({ outcome: 'skipped', folded: 0 });
    expect(await memories(conv.id)).toHaveLength(1);
    // The ledger records the fold for its tenant with purpose `summarise`.
    const folds = usage.slice(before).filter((e) => e.purpose === 'summarise');
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({
      tenantId: TENANT_A,
      conversationId: conv.id,
      model: 'summarise',
    });
    // Tenant B's job for A's conversation sees nothing (RLS) and does nothing.
    expect(
      await runSummariseJob(
        { llm, withTx: (fn) => withTenant(visitor(), TENANT_B, fn) },
        { ...job, tenantId: TENANT_B },
      ),
    ).toEqual({ outcome: 'skipped', folded: 0 });
  });

  it('AC-4: suggestions and replay load the memory as of their question (D3), in the dashboard zone', async () => {
    const conv = await conversation();
    await chat(conv, 20);
    await runSummariseJob(
      { llm, withTx },
      { kind: 'summarise', tenantId: TENANT_A, conversationId: conv.id },
    );
    const [row] = await memories(conv.id);
    const cutoff = Number(row!.upto_seq);
    const all = await seqs(conv.id);
    const load = (upToSeq: number) =>
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        loadConversationHistory(tx, { tenantId: TENANT_A, conversationId: conv.id, upToSeq }),
      );
    const early = await load(cutoff);
    expect(early.memory).toBeNull();
    expect(early.messages.map((m) => m.seq)).toEqual(all.filter((s) => s <= cutoff));
    const late = await load(all.at(-1)!);
    expect(late.memory?.visitorName).toBe('Siti');
    expect(late.messages.map((m) => m.seq)).toEqual(all.filter((s) => s > cutoff));
    expect(late.unfolded).toBe(all.filter((s) => s > cutoff).length);
  });

  it('AC-4, AC-7: the next turn carries the memory and only the messages after it, also after a move to Telegram', async () => {
    const conv = await conversation();
    await chat(conv, 20);
    const job = { kind: 'summarise' as const, tenantId: TENANT_A, conversationId: conv.id };
    await runSummariseJob({ llm, withTx }, job);
    const [row] = await memories(conv.id);
    // The conversation moves to Telegram (FEAT-038 D2: the same conversation, its channel changed).
    await owner.query(`update conversations set channel = 'telegram' where id = $1`, [conv.id]);
    const from = requests.length;
    await say(conv, 'so can you confirm my order?');
    const sent = requests.slice(from);
    const reply = sent.find((r) => r.model !== 'triage' && r.system !== SUMMARY_SYSTEM)!;
    const tri = sent.find((r) => r.model === 'triage')!;
    expect(reply.tail).toMatch(
      /^<memory>\nname: Siti\nwants: boxes of pineapple tarts \| quantity: 40\ndate: 14 Dec\n<\/memory>/,
    );
    expect(tri.tail).toContain('wants: boxes of pineapple tarts | quantity: 40');
    expect(tri.tail).not.toContain('Siti');
    // Verbatim: only the messages after the fold's cutoff (and none folded).
    const after = (await seqs(conv.id)).filter((s) => s > Number(row!.upto_seq)).length - 1;
    expect(reply.messages.length).toBeLessThanOrEqual(after);
    expect(reply.messages.some((m) => m.content.includes('Siti'))).toBe(false);
    expect(reply.system).toContain('<memory>');
  });
  // Acceptance verification additions (FEAT-026 verify): AC-2's gate-closed case, AC-3's
  // concurrent fold and D5's verbatim cap had no test.
  it('AC-2 (verify): a gate-closed turn stores nothing and enqueues nothing', async () => {
    const conv = await conversation();
    await chat(conv, 18);
    expect(await jobs(conv.id)).toEqual([]);
    await owner.query(`update conversations set status = 'human' where id = $1`, [conv.id]);
    const before = (await seqs(conv.id)).length;
    await say(conv, FILLER);
    expect((await seqs(conv.id)).length).toBe(before + 1); // only the visitor's message
    expect(await jobs(conv.id)).toEqual([]);
  });

  it('AC-3 (verify): two concurrent folds write one memory row', async () => {
    const conv = await conversation();
    await chat(conv, 20);
    const job = { kind: 'summarise' as const, tenantId: TENANT_A, conversationId: conv.id };
    const outcomes = await Promise.all([
      runSummariseJob({ llm, withTx }, job),
      runSummariseJob({ llm, withTx }, job),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'saved')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome !== 'saved').map((o) => o.folded)).toEqual([0]);
    expect(await memories(conv.id)).toHaveLength(1);
  });

  it('D5, AC-1 (verify): with the summariser lagging, a turn loads at most the newest 30 messages', async () => {
    const conv = await conversation();
    await chat(conv, 40);
    const all = await seqs(conv.id);
    const h = await withTx((tx) =>
      loadConversationHistory(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        upToSeq: all.at(-1)!,
      }),
    );
    expect(h.memory).toBeNull();
    expect(h.unfolded).toBe(all.length);
    expect(h.messages.map((m) => m.seq)).toEqual(all.slice(-30));
    const from = requests.length;
    await say(conv, FILLER);
    const reply = requests
      .slice(from)
      .find((r) => r.model !== 'triage' && r.system !== SUMMARY_SYSTEM)!;
    expect(reply.messages.length).toBeLessThanOrEqual(30);
  });
});
