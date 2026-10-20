import { randomUUID } from 'node:crypto';
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
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeVisitorResponder, runVisitorTurn, texts } from '../src/index.js';

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
  await owner.query(`update tenants set ai_paused = false`);
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

function llmWith(script: FakeScript) {
  const calls = { generate: 0 };
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => {
      calls.generate++;
      return script(req);
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
      expect(sent.length).toBeGreaterThanOrEqual(2); // the query embedding and the reply
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
