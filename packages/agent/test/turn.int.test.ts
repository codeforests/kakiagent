import { randomUUID } from 'node:crypto';
import { DEFAULT_GOVERNOR, runCostGovernor, usageSink } from '@kaki/analytics';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation, messagesSince } from '@kaki/inbox';
import {
  createFact,
  dashboardKb,
  getFact,
  mergePatch,
  prepareChunk,
  updateFact,
  type FactInput,
  type FactPatch,
} from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  scriptedOutputs,
  type FakeScript,
  type GenerateRequest,
  type ModelProvider,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRegistry,
  fakeAgentScript,
  fakeTriage,
  fakeVisitorResponder,
  runVisitorTurn,
  texts,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const embedder = gatewayFromConfig({ provider: 'fake' });
const ids: Record<string, string> = {};

async function addFact(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(embedder, tenantId, input);
  return withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    createFact(dashboardKb(tx, tenantId, 'owner-1'), input, chunk),
  );
}

async function editFact(tenantId: string, id: string, patch: FactPatch) {
  const dash = tdb.zone('dashboard');
  const current = await withTenant(dash, tenantId, (tx) =>
    getFact(dashboardKb(tx, tenantId, 'o'), id),
  );
  const chunk = await prepareChunk(embedder, tenantId, mergePatch(current, patch));
  return withTenant(dash, tenantId, (tx) =>
    updateFact(dashboardKb(tx, tenantId, 'o'), id, patch, chunk),
  );
}

const product = (name: string, cents: number): FactInput => ({
  type: 'product',
  value: { name, priceCents: cents, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ids.fudge = (await addFact(TENANT_A, product('Chocolate fudge cake', 5500))).id;
  ids.eggless = (
    await addFact(TENANT_A, {
      type: 'faq',
      value: { question: 'Do you have eggless cakes?', answer: 'Yes, on request, 3 days ahead.' },
      gstTreatment: null,
    })
  ).id;
  // Matches the question best, but waits for review: never used (AC-7).
  ids.review = (await addFact(TENANT_A, product('Eggless chocolate cake', 7000))).id;
  await owner.query(`update facts set status = 'needs_review' where id = $1`, [ids.review]);
  // Another tenant's fudge cake at S$99 (AC-7).
  ids.other = (await addFact(TENANT_B, product('Chocolate fudge cake', 9900))).id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(
    `update tenants set ai_paused = false, route_complexity_threshold = 0.6,
       route_min_confidence = 0.5, cost_governor_step = 0`,
  );
});

async function conversationWith(text: string) {
  const zdb = tdb.zone('visitor');
  const visitorId = randomUUID();
  const conv = await withTenant(zdb, TENANT_A, (tx) => createConversation(tx, TENANT_A, visitorId));
  const messageId = await say(conv.id, visitorId, text);
  return { zdb, visitorId, conversationId: conv.id, messageId };
}

async function say(conversationId: string, visitorId: string, text: string) {
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

/** The fake model: triage requests get the fake triager (FEAT-004), replies get `script`. */
function llmWith(script: FakeScript, triageScript: FakeScript = fakeTriage) {
  const calls = { generate: 0, models: [] as GenerateRequest['model'][] };
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => {
      calls.generate++;
      calls.models.push(req.model);
      return req.model === 'triage' ? triageScript(req) : script(req);
    }),
  ]);
  return { llm, calls };
}

async function turn(
  c: { conversationId: string; messageId: string },
  script: FakeScript = fakeVisitorResponder,
) {
  const { llm, calls } = llmWith(script);
  const segments: { turnId: string; seq: number; text: string }[] = [];
  const result = await runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm, publishSegment: async (s) => void segments.push(s) },
    { tenantId: TENANT_A, conversationId: c.conversationId, messageId: c.messageId },
  );
  return { result, segments, calls };
}

/** Audit entries whose primary subject is `subjectId`, in chain order (FEAT-002). */
async function auditRows(subjectId: string) {
  const { rows } = await owner.query(
    `select event_type, payload, subject_refs from audit_entries
     where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
    [subjectId],
  );
  return rows as { event_type: string; payload: Record<string, unknown>; subject_refs: string[] }[];
}

async function auditActions(subjectId: string) {
  return (await auditRows(subjectId)).map((r) => r.event_type);
}

describe('runVisitorTurn (UC-20)', () => {
  it('answers from approved facts only, with fact IDs, disclosure and audit (AC-4, AC-7, AC-8)', async () => {
    const c = await conversationWith('got eggless cake or not? how much ah');
    const { result, segments } = await turn(c);
    expect(result?.outcome).toBe('answered');
    const body = result!.message.body;
    expect(body).toContain('S$55.00');
    expect(body).toContain('3 days ahead');
    expect(body).not.toContain('S$70');
    expect(body).not.toContain('S$99');
    expect(result!.message.factIds.sort()).toEqual([ids.fudge, ids.eggless].sort());
    expect(result!.message.factIds).not.toContain(ids.review);
    expect(result!.message.factIds).not.toContain(ids.other);
    expect(result!.message.disclosure).toBe(texts.disclosure('Kaki Bakery'));
    expect(segments.map((s) => s.text).join(' ')).toBe(body);
    expect(segments.every((s) => s.turnId === c.messageId)).toBe(true);
    expect(await auditActions(result!.message.id)).toEqual(['message.ai_sent', 'agent.decision']);
    expect(await auditActions(c.conversationId)).toContain('tool.lookup_kb');
    // GOV-01 agent decisions (FEAT-002 AC-8): KB IDs retrieved, the tool, the rationale.
    const lookup = (await auditRows(c.conversationId)).find(
      (r) => r.event_type === 'tool.lookup_kb',
    )!;
    expect(lookup.payload.tool).toBe('lookup_kb');
    expect(lookup.payload.factIds).toEqual(expect.arrayContaining([ids.fudge, ids.eggless]));
    expect(lookup.payload.factIds).not.toContain(ids.review);
    expect(lookup.payload.factIds).not.toContain(ids.other);
    const decision = (await auditRows(result!.message.id)).find(
      (r) => r.event_type === 'agent.decision',
    )!;
    expect(decision.subject_refs).toEqual([
      `message:${result!.message.id}`,
      `conversation:${c.conversationId}`,
    ]);
    expect(decision.payload).toEqual({
      outcome: 'answered',
      factIds: expect.arrayContaining([ids.fudge, ids.eggless]),
      attempts: 1,
      violations: 0,
      route: 'reply.simple',
      models: ['reply.simple'],
      tasks: ['answer'],
      planFallback: false,
    });
    expect((decision.payload.factIds as string[]).sort()).toEqual(result!.message.factIds.sort());
  });

  it('discloses only on the first reply of a conversation (AC-8)', async () => {
    const c = await conversationWith('hello');
    await turn(c);
    const second = await say(c.conversationId, c.visitorId, 'do you have eggless cakes?');
    const { result } = await turn({ conversationId: c.conversationId, messageId: second });
    expect(result?.message.disclosure).toBeNull();
  });

  it('replies once, even when the turn is delivered twice (at-least-once SQS)', async () => {
    const c = await conversationWith('how much is the chocolate fudge cake?');
    const first = await turn(c);
    const second = await turn(c);
    expect(first.result).not.toBeNull();
    expect(second.result).toBeNull();
    expect(second.calls.generate).toBe(0);
    const all = await withTenant(c.zdb, TENANT_A, (tx) =>
      messagesSince(tx, {
        tenantId: TENANT_A,
        conversationId: c.conversationId,
        afterSeq: 0,
        visitorId: c.visitorId,
      }),
    );
    expect(all.map((m) => m.author)).toEqual(['visitor', 'agent']);
  });

  it('uses an edited price on the very next turn, and drops a disabled fact (AC-9)', async () => {
    const fact = await addFact(TENANT_A, product('Pandan chiffon', 3200));
    await editFact(TENANT_A, fact.id, {
      version: 1,
      value: { ...product('Pandan chiffon', 3600).value },
    });
    const c = await conversationWith('how much is the pandan chiffon');
    const { result } = await turn(c);
    expect(result?.message.body).toContain('S$36.00');
    expect(result?.message.body).not.toContain('S$32.00');
    await editFact(TENANT_A, fact.id, { version: 2, status: 'disabled' });
    const c2 = await conversationWith('how much is the pandan chiffon');
    const again = await turn(c2);
    expect(again.result?.message.factIds).not.toContain(fact.id);
  });

  it('blocks a literal wrong price twice, escalates, and audits the guardrail (AC-2)', async () => {
    const c = await conversationWith('how much is the fudge cake');
    const { result, segments } = await turn(c, scriptedOutputs(['It is S$50.', 'Only $45 lah.']));
    expect(result?.outcome).toBe('escalated');
    expect(result?.message.body).toBe(texts.escalation);
    expect(segments.map((s) => s.text)).toEqual([texts.escalation]);
    expect(segments.some((s) => /S?\$\s?\d/.test(s.text))).toBe(false);
    expect(await auditActions(result!.message.id)).toEqual([
      'message.ai_sent',
      'guardrail.segment_blocked',
      'guardrail.segment_blocked',
      'guardrail.escalated',
      'agent.decision',
    ]);
    // The rule that fired is logged, never the blocked text (FEAT-002 AC-8).
    const rows = await auditRows(result!.message.id);
    const blocked = rows.filter((r) => r.event_type === 'guardrail.segment_blocked');
    // Both scripted outputs are literal currency amounts, so the logged kind must be the
    // verifier's `currency` rule, one entry per blocked segment (FEAT-002 acceptance).
    expect(blocked.map((r) => r.payload)).toEqual([{ kind: 'currency' }, { kind: 'currency' }]);
    expect(JSON.stringify(rows)).not.toMatch(/S\$50|\$45|fudge/i);
    expect(rows.at(-1)!.payload).toMatchObject({
      outcome: 'escalated',
      factIds: [],
      violations: 2,
      models: ['reply.simple', 'reply.complex'],
    });
  });

  it('stores the fallback as the reply when the model call fails (AC-13, D6)', async () => {
    const c = await conversationWith('boom');
    const { result } = await turn(c, () => {
      throw new Error('model unavailable');
    });
    expect(result?.outcome).toBe('unavailable');
    expect(result?.message).toMatchObject({
      author: 'system',
      body: texts.fallback,
      inReplyTo: c.messageId,
    });
    expect(await auditActions(result!.message.id)).toContain('agent.fallback_sent');
    const again = await turn(c);
    expect(again.result).toBeNull();
  });

  it('with the kill switch on, makes no model call and sends the fallback (AC-14)', async () => {
    await owner.query(`update tenants set ai_paused = true where id = $1`, [TENANT_A]);
    const c = await conversationWith('how much is the fudge cake');
    const { result, calls, segments } = await turn(c);
    expect(calls.generate).toBe(0);
    expect(segments).toEqual([]);
    expect(result?.message).toMatchObject({ author: 'system', body: texts.fallback });
    expect(result?.message.disclosure).toBe(texts.disclosure('Kaki Bakery'));
  });

  it('says nothing while a human owns the conversation (AC-14, UC-20 5e)', async () => {
    const c = await conversationWith('how much is the fudge cake');
    await owner.query(`update conversations set status = 'human' where id = $1`, [
      c.conversationId,
    ]);
    const { result, calls } = await turn(c);
    expect(result).toBeNull();
    expect(calls.generate).toBe(0);
  });

  it('stops between segments when the kill switch is pressed mid-reply (AC-14)', async () => {
    const c = await conversationWith('how much is the fudge cake');
    const { llm } = llmWith(() => 'First sentence. Second sentence. Third sentence.');
    const segments: string[] = [];
    const result = await runVisitorTurn(
      {
        zdb: tdb.zone('visitor'),
        llm,
        publishSegment: async (s) => {
          segments.push(s.text);
          await owner.query(`update tenants set ai_paused = true where id = $1`, [TENANT_A]);
        },
      },
      { tenantId: TENANT_A, conversationId: c.conversationId, messageId: c.messageId },
    );
    expect(segments).toEqual(['First sentence.']);
    expect(result?.outcome).toBe('paused');
    expect(result?.message.body).toBe(`First sentence. ${texts.fallback}`);
  });

  it('sends the model and the embedder only masked visitor text (GOV-04, FEAT-003 AC-6)', async () => {
    // AC-6: the turn on the AC-5 message, so the bank number is checked too (acceptance correction).
    const raw = [
      'S1234567D',
      '4242 4242 4242 4242',
      '4242424242424242',
      '123-456789-0',
      '1234567890',
    ];
    const c = await conversationWith(
      'fudge cake price? IC S1234567D, card 4242 4242 4242 4242, refund to DBS acct 123-456789-0',
    );
    // What the agent hands the gateway, and what the provider receives behind it.
    const toGateway: unknown[] = [];
    const toProvider: unknown[] = [];
    const fake = createFakeProvider(fakeVisitorResponder);
    const inner = createGateway(defaultRegistry('fake'), [
      {
        ...fake,
        generate: async (req, id) => (toProvider.push(req), fake.generate(req, id)),
        stream: (req, id) => (toProvider.push(req), fake.stream!(req, id)),
        embed: async (req, id) => (toProvider.push(req), fake.embed!(req, id)),
      },
    ]);
    const llm: typeof inner = {
      generate: (req) => (toGateway.push(req), inner.generate(req)),
      stream: (req) => (toGateway.push(req), inner.stream(req)),
      embed: (req) => (toGateway.push(req), inner.embed(req)),
    };
    const result = await runVisitorTurn(
      { zdb: tdb.zone('visitor'), llm },
      { tenantId: TENANT_A, conversationId: c.conversationId, messageId: c.messageId },
    );
    expect(result).not.toBeNull();
    for (const sent of [toGateway, toProvider]) {
      expect(sent.length).toBeGreaterThanOrEqual(3); // triage, the query embedding and the reply
      const text = JSON.stringify(sent);
      for (const r of raw) expect(text).not.toContain(r);
      expect(text).toContain('[NRIC ••••567D]');
      expect(text).toContain('[CARD ••••4242]');
      expect(text).toContain('[BANK ••••7890]');
    }
  });

  it('ignores a job whose message is missing', async () => {
    const llm = gatewayFromConfig({ provider: 'fake' });
    const res = await runVisitorTurn(
      { zdb: tdb.zone('visitor'), llm },
      { tenantId: TENANT_A, conversationId: randomUUID(), messageId: randomUUID() },
    );
    expect(res).toBeNull();
  });
});

describe('runVisitorTurn with triage, dispatch and routing (FEAT-004)', () => {
  const job = (c: { conversationId: string; messageId: string }) => ({
    tenantId: TENANT_A,
    conversationId: c.conversationId,
    messageId: c.messageId,
  });
  const decisionOf = async (messageId: string) =>
    (await auditRows(messageId)).find((r) => r.event_type === 'agent.decision')!.payload;

  it('answers a multi-task message and audits each task the empty registry cannot handle (AC-7, AC-8)', async () => {
    const c = await conversationWith(
      'how much for 50 kueh, can deliver Saturday? my number is 9123 4567',
    );
    const { result } = await turn(c);
    expect(result?.outcome).toBe('answered');
    expect(result?.plan?.fallback).toBe(false);
    expect(result?.plan?.tasks.map((t) => t.kind)).toEqual([
      'answer',
      'request_commitment',
      'capture_lead',
    ]);
    expect(result?.dispatched).toEqual([
      { task: 'request_commitment', index: 1, outcome: 'unhandled' },
      { task: 'capture_lead', index: 2, outcome: 'unhandled' },
    ]);
    expect(result?.route).toBe('reply.complex');
    expect(result?.timings?.triageMs).toEqual(expect.any(Number));
    const dispatches = (await auditRows(c.messageId)).filter(
      (r) => r.event_type === 'agent.dispatch',
    );
    expect(dispatches.map((r) => r.payload)).toEqual([
      { task: 'request_commitment', outcome: 'unhandled' },
      { task: 'capture_lead', outcome: 'unhandled' },
    ]);
    expect(dispatches[0]!.subject_refs).toEqual([
      `message:${c.messageId}`,
      `conversation:${c.conversationId}`,
    ]);
    // Codes only: no argument or visitor text reaches the chain (ADR-014).
    expect(JSON.stringify(dispatches)).not.toContain('9123');
    expect(await decisionOf(result!.message.id)).toMatchObject({
      route: 'reply.complex',
      models: ['reply.complex'],
      tasks: ['answer', 'request_commitment', 'capture_lead'],
      planFallback: false,
    });
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('provider down');
      },
    ],
    ['returns invalid JSON', () => 'not json {'],
    ['returns no tasks', () => JSON.stringify({ language: 'en', tasks: [] })],
  ])(
    'falls back to the answer plan when triage %s, still answers and routes complex (AC-1)',
    async (_, triageScript) => {
      const c = await conversationWith('how much is the fudge cake');
      const { llm } = llmWith(fakeVisitorResponder, triageScript);
      const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c));
      expect(result?.outcome).toBe('answered');
      expect(result?.message.body).toContain('S$55.00');
      expect(result?.plan?.fallback).toBe(true);
      expect(result?.plan?.tasks.map((t) => t.kind)).toEqual(['answer']);
      expect(result?.dispatched).toEqual([]);
      expect(result?.route).toBe('reply.complex');
      expect(await decisionOf(result!.message.id)).toMatchObject({
        route: 'reply.complex',
        planFallback: true,
      });
    },
  );

  it('routes by the tenant threshold and the governor step (AC-2)', async () => {
    const text = 'price for 2 fudge, 3 eggless and 4 pandan?'; // complexity 0.8
    const routed = async () => (await turn(await conversationWith(text))).result?.route;
    expect(await routed()).toBe('reply.complex');
    await owner.query(`update tenants set route_complexity_threshold = 0.85 where id = $1`, [
      TENANT_A,
    ]);
    expect(await routed()).toBe('reply.simple');
    await owner.query(
      `update tenants set route_complexity_threshold = 0.6, cost_governor_step = 3 where id = $1`,
      [TENANT_A],
    );
    expect(await routed()).toBe('reply.simple');
    // Low triage confidence goes to the larger model whatever the governor says.
    await owner.query(`update tenants set route_min_confidence = 0.95 where id = $1`, [TENANT_A]);
    expect(await routed()).toBe('reply.complex');
    // Another tenant's settings are its own.
    const { rows } = await owner.query(
      `select route_complexity_threshold, cost_governor_step from tenants where id = $1`,
      [TENANT_B],
    );
    expect(rows[0]).toEqual({ route_complexity_threshold: 0.6, cost_governor_step: 0 });
  });

  // Acceptance correction (AC-6): the criterion ends with "the next turn of a raised
  // tenant routes with the raised threshold"; no test ran the governor and then a turn.
  it('routes the next turn with the threshold the cost governor raised (AC-6)', async () => {
    const plan = JSON.stringify({
      language: 'en',
      register: 'standard',
      complexity: 0.65,
      confidence: 0.9,
      flags: { complaint: false, injection: false },
      tasks: [{ kind: 'answer', args: [] }],
    });
    const routed = async () => {
      const { llm } = llmWith(fakeVisitorResponder, () => plan);
      const c = await conversationWith('how much is the fudge cake');
      return (await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c)))?.route;
    };
    await owner.query(
      `update tenants set cost_governor_step = 0, cost_governor_changed_at = null where id = $1`,
      [TENANT_A],
    );
    expect(await routed()).toBe('reply.complex'); // 0.65 ≥ 0.6
    // 25 conversations at S$0.04 each over the last day: above the S$0.025 target.
    const seeded = await owner.query(
      `insert into usage_events (tenant_id, conversation_id, purpose, model, provider, provider_model_id, cost_usd)
       select $1, gen_random_uuid(), 'reply', 'reply.simple', 'fake', 'fake-haiku', $2
       from generate_series(1, 25) returning id`,
      [TENANT_A, 0.04 / DEFAULT_GOVERNOR.usdToSgd],
    );
    try {
      const changes = await runCostGovernor(tdb.zone('outbox'));
      expect(changes).toEqual([expect.objectContaining({ tenantId: TENANT_A, newStep: 1 })]);
      expect(await routed()).toBe('reply.simple'); // 0.65 < 0.6 + 0.1
    } finally {
      await owner.query(`delete from usage_events where id = any($1::uuid[])`, [
        seeded.rows.map((r) => r.id),
      ]);
      await owner.query(`update tenants set cost_governor_changed_at = null where id = $1`, [
        TENANT_A,
      ]);
    }
  });

  it('runs triage alongside retrieval, so the reply starts after one delay, not two (AC-9)', async () => {
    const DELAY = 200;
    const sleep = () => new Promise((r) => setTimeout(r, DELAY));
    const fake = createFakeProvider(fakeAgentScript);
    let t0 = 0;
    let replyAt = 0;
    const provider: ModelProvider = {
      ...fake,
      async generate(req, id) {
        if (req.model === 'triage') await sleep();
        return fake.generate(req, id);
      },
      async *stream(req, id) {
        replyAt ||= performance.now() - t0;
        yield* fake.stream!(req, id);
      },
      async embed(req, id) {
        await sleep();
        return fake.embed!(req, id);
      },
    };
    const llm = createGateway(defaultRegistry('fake'), [provider]);
    const c = await conversationWith('how much is the fudge cake');
    t0 = performance.now();
    const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c));
    expect(result?.outcome).toBe('answered');
    expect(replyAt).toBeGreaterThanOrEqual(DELAY);
    expect(replyAt).toBeLessThan(DELAY * 2 - 50);
    expect(result?.timings?.triageMs).toBeGreaterThanOrEqual(DELAY - 5);
  });

  it('records one ledger row per model call of the turn when the sink is wired (AC-4)', async () => {
    const warned: string[] = [];
    const llm = createGateway(defaultRegistry('fake'), [createFakeProvider(fakeAgentScript)], {
      onUsage: usageSink(tdb.zone('visitor'), { warn: (_, msg) => void warned.push(msg) }),
    });
    const c = await conversationWith('how much is the fudge cake');
    const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c));
    expect(result?.outcome).toBe('answered');
    expect(warned).toEqual([]);
    const { rows } = await owner.query(
      `select tenant_id, conversation_id, purpose, model, input_tokens, cost_usd
       from usage_events where turn_id = $1 order by created_at, purpose`,
      [c.messageId],
    );
    expect(rows.map((r) => r.purpose).sort()).toEqual(['embed', 'reply', 'triage']);
    expect(rows.map((r) => r.model).sort()).toEqual(['embed', 'reply.simple', 'triage']);
    for (const r of rows) {
      expect(r.tenant_id).toBe(TENANT_A);
      expect(r.conversation_id).toBe(c.conversationId);
      expect(r.input_tokens).toBeGreaterThan(0);
      expect(Number(r.cost_usd)).toBeGreaterThan(0);
    }
  });

  // Acceptance correction (AC-4): the criterion names every field of each row, a row for
  // a regeneration, and rows that hold no message text; the test above checked a subset.
  it('records each call with its turn, provider model, four token counts and cost, a regeneration included, and no text (AC-4)', async () => {
    const replies = scriptedOutputs(['It is S$50.', 'Only $45 lah.']);
    const llm = createGateway(
      defaultRegistry('fake'),
      [createFakeProvider((req) => (req.model === 'triage' ? fakeTriage(req) : replies(req)))],
      { onUsage: usageSink(tdb.zone('visitor'), { warn: () => {} }) },
    );
    const c = await conversationWith('how much is the fudge cake');
    const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c));
    expect(result?.outcome).toBe('escalated');
    const { rows } = await owner.query(
      `select * from usage_events where turn_id = $1 order by created_at`,
      [c.messageId],
    );
    expect(rows.map((r) => [r.purpose, r.model, r.provider_model_id]).sort()).toEqual(
      [
        ['embed', 'embed', 'fake-embed'],
        ['reply', 'reply.complex', 'fake-sonnet'],
        ['reply', 'reply.simple', 'fake-haiku'],
        ['triage', 'triage', 'fake-haiku'],
      ].sort(),
    );
    for (const r of rows) {
      expect(r).toMatchObject({
        tenant_id: TENANT_A,
        conversation_id: c.conversationId,
        turn_id: c.messageId,
        provider: 'fake',
      });
      for (const k of [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_write_input_tokens',
      ])
        expect(r[k]).toEqual(expect.any(Number));
      expect(Number(r.cost_usd)).toBeGreaterThan(0);
    }
    // The row is IDs, codes, counts and cost: no visitor or reply text.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'tenant_id',
        'id',
        'conversation_id',
        'turn_id',
        'purpose',
        'model',
        'provider',
        'provider_model_id',
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_write_input_tokens',
        'cost_usd',
        'created_at',
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/fudge|S\$50|\$45/i);
  });

  it('still answers when the ledger insert fails, and logs it (AC-4, NFR-04)', async () => {
    const warned: string[] = [];
    // The outbox zone has no INSERT on usage_events, so every write fails.
    const llm = createGateway(defaultRegistry('fake'), [createFakeProvider(fakeAgentScript)], {
      onUsage: usageSink(tdb.zone('outbox'), { warn: (_, msg) => void warned.push(msg) }),
    });
    const c = await conversationWith('how much is the fudge cake');
    const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm }, job(c));
    expect(result?.outcome).toBe('answered');
    expect(result?.message.body).toContain('S$55.00');
    expect(warned).toEqual([
      'usage event not recorded',
      'usage event not recorded',
      'usage event not recorded',
    ]);
    const { rows } = await owner.query(`select 1 from usage_events where turn_id = $1`, [
      c.messageId,
    ]);
    expect(rows).toEqual([]);
  });

  it('ends the turn with a safety handler’s text and makes no reply call (ADR-025 decision 6)', async () => {
    const ran: string[] = [];
    const registry = createRegistry([
      {
        kind: 'crisis',
        scopes: ['visitor'],
        args: z.unknown(),
        async run(_ctx, _args, key) {
          ran.push(key);
          return { endTurn: { text: 'Please call SOS at 1767.' } };
        },
      },
    ]);
    const { llm, calls } = llmWith(fakeVisitorResponder);
    const c = await conversationWith('i want to end my life');
    const result = await runVisitorTurn({ zdb: tdb.zone('visitor'), llm, registry }, job(c));
    expect(result?.outcome).toBe('ended');
    expect(result?.message.body).toBe('Please call SOS at 1767.');
    expect(ran).toEqual([`${c.messageId}:0`]);
    expect(calls.models).toEqual(['triage']);
    expect(result?.route).toBeNull();
    expect(result?.dispatched).toEqual([{ task: 'crisis', index: 0, outcome: 'done' }]);
    expect(await decisionOf(result!.message.id)).toMatchObject({
      outcome: 'ended',
      route: null,
      tasks: ['crisis'],
    });
  });
});
