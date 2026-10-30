/**
 * Boundary rules in the visitor turn (APR-01, UC-29 3; FEAT-054 §5.3; AC-5, AC-6, AC-7, AC-8):
 * the rules saved last apply to the next turn, a blocked topic is refused in code with no
 * reply-model call, and the decision records which version applied.
 */
import { randomUUID } from 'node:crypto';
import { SAFE_DEFAULTS, saveRules, type BoundaryRules } from '@kaki/approvals';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk, type FactInput } from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  scriptedOutputs,
  type FakeScript,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRegistry,
  fakeTriage,
  fakeVisitorResponder,
  runVisitorTurn,
  textsFor,
  visitorRegistry,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let business: string;
const USER = '00000000-0000-4000-8000-0000000000b1';
const embedder = gatewayFromConfig({ provider: 'fake' });

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(`update business_profiles set hours = null`);
  business = (await owner.query(`select name from tenants where id = $1`, [TENANT_A])).rows[0].name;
  const input: FactInput = {
    type: 'product',
    value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
    gstTreatment: 'inclusive',
  };
  const chunk = await prepareChunk(embedder, TENANT_A, input);
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFact(dashboardKb(tx, TENANT_A, 'owner-1'), input, chunk),
  );
});
afterEach(async () => {
  await owner.query(`delete from boundary_rules`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

async function save(rules: Partial<BoundaryRules>) {
  const current = await owner.query(
    `select max(version)::int as v from boundary_rules where tenant_id = $1`,
    [TENANT_A],
  );
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    saveRules(tx, TENANT_A, {
      expectedVersion: current.rows[0].v,
      rules: { ...SAFE_DEFAULTS, ...rules },
      userId: USER,
    }),
  );
}

async function ask(
  text: string,
  script: FakeScript = fakeVisitorResponder,
  registry = visitorRegistry,
) {
  const zdb = tdb.zone('visitor');
  const visitorId = randomUUID();
  const conv = await withTenant(zdb, TENANT_A, (tx) => createConversation(tx, TENANT_A, visitorId));
  const { message } = await withTenant(zdb, TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  const requests: GenerateRequest[] = [];
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => {
      requests.push(req);
      return req.model === 'triage' ? fakeTriage(req) : script(req);
    }),
  ]);
  const result = await runVisitorTurn(
    { zdb, llm, registry },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
  return { result: result!, requests };
}

async function audits(messageId: string) {
  const { rows } = await owner.query(
    `select event_type, payload from audit_entries
     where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
    [messageId],
  );
  return rows as { event_type: string; payload: Record<string, unknown> }[];
}

describe('boundary rules in the visitor turn (FEAT-054)', () => {
  it('runs on the safe defaults with an unchanged triage request (AC-1, AC-5)', async () => {
    const { result, requests } = await ask('How much is the chocolate fudge cake?');
    expect(result.outcome).toBe('answered');
    const triage = requests.find((r) => r.model === 'triage')!;
    expect(triage.tail).toBeUndefined();
    const decision = (await audits(result.message.id)).at(-1)!;
    expect(decision.event_type).toBe('agent.decision');
    expect(decision.payload).toMatchObject({ rulesVersion: null });
  });

  it('refuses a blocked topic on the next turn after a save, with no reply-model call (AC-5, AC-6)', async () => {
    const saved = await save({ blockedTopics: ['Politics'], allowedTopics: ['Cakes'] });
    const { result, requests } = await ask('What do you think about politics?');
    expect(result.message.body).toBe(textsFor('en').blockedTopic(business));
    expect(result.outcome).toBe('out_of_scope');
    expect(requests.map((r) => r.model)).toEqual(['triage']);
    expect(requests[0]!.tail).toContain('["Politics"]');
    const rows = await audits(result.message.id);
    expect(rows.map((r) => r.event_type)).toContain('guardrail.boundary_topic');
    expect(rows.at(-1)!.payload).toMatchObject({ rulesVersion: saved.version });
    // No topic text in the chain (ADR-014).
    expect(JSON.stringify(rows)).not.toMatch(/politics/i);
  });

  it("refuses a paraphrase that only triage catches, and the plan's other tasks still run (AC-6)", async () => {
    await save({ blockedTopics: ["Competitors' prices"] });
    const { result, requests } = await ask(
      'Is your competitor any good? I want to talk to a person',
    );
    expect(result.message.body).toContain(textsFor('en').blockedTopic(business));
    expect(requests.some((r) => r.model !== 'triage')).toBe(false);
    // The answer became the refusal; the escalation is still dispatched (no handler yet).
    expect(result.plan?.tasks.map((t) => t.kind)).toEqual(['escalate', 'out_of_scope']);
    expect(result.dispatched.map((d) => d.task)).toEqual(['escalate', 'out_of_scope']);
  });

  it('refuses a blocked topic in Chinese by phrase (AC-6)', async () => {
    await save({ blockedTopics: ['政治'] });
    const { result } = await ask('你们对政治有什么看法？');
    expect(result.message.body).toBe(textsFor('zh').blockedTopic(business));
  });

  it('gives the dispatcher the rules in force (AC-8)', async () => {
    await save({ maxDiscountPct: 15, quotesNeedApproval: false });
    const seen: unknown[] = [];
    const registry = createRegistry([
      ...[...visitorRegistry.byKind.values()].filter((h) => h.kind !== 'escalate'),
      {
        kind: 'escalate',
        scopes: ['visitor'],
        args: z.record(z.string(), z.unknown()).catch({}),
        checkBoundary: (rules) => {
          seen.push(rules);
          return true;
        },
        run: async () => ({}),
      },
    ]);
    await ask('Can I talk to a person?', fakeVisitorResponder, registry);
    expect(seen).toEqual([
      expect.objectContaining({ maxDiscountPct: 15, quotesNeedApproval: false }),
    ]);
  });

  it('never releases a guarantee: one regeneration, then the escalation text, audited (AC-7)', async () => {
    const { result, requests } = await ask(
      'Will my cake arrive by 3pm?',
      // The verifier already blocks the word "guarantee" (policy); this is the phrasing
      // only the boundary guard catches.
      scriptedOutputs([
        'Yes, it will definitely arrive on time.',
        'It will surely arrive by then.',
      ]),
    );
    expect(result.outcome).toBe('escalated');
    expect(result.message.body).toBe(textsFor('en').escalation);
    expect(requests.filter((r) => r.model !== 'triage').map((r) => r.model)).toEqual([
      'reply.simple',
      'reply.complex',
    ]);
    // The rules reach the reply prompt's cached block (safe defaults: no version yet).
    expect(requests[1]!.system).toContain('Never promise: delivery dates or guaranteed delivery');
    const rows = await audits(result.message.id);
    expect(rows.filter((r) => r.event_type.startsWith('guardrail.'))).toEqual([
      { event_type: 'guardrail.boundary_commitment', payload: { kind: 'commitment' } },
      { event_type: 'guardrail.boundary_commitment', payload: { kind: 'commitment' } },
      { event_type: 'guardrail.escalated', payload: {} },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/definitely|surely/i);
  });

  it('blocks a discount offer and the fake model defers to the team on regeneration (AC-7, D4)', async () => {
    await save({ maxDiscountPct: 20 });
    const { result } = await ask('Can I get a special price for 3 cakes?');
    expect(result.message.body).toBe("I'll check that with the team and get back to you.");
    const rows = await audits(result.message.id);
    expect(rows.map((r) => r.event_type)).toContain('guardrail.boundary_discount');
  });

  it('releases a guarantee once delivery_guarantee is unticked (AC-7)', async () => {
    await save({ forbiddenCommitments: ['refund', 'legal_advice', 'medical_advice'] });
    const { result } = await ask(
      'Will my cake arrive by 3pm?',
      scriptedOutputs(['Yes, it will definitely arrive on time.']),
    );
    expect(result.outcome).toBe('answered');
    expect(result.message.body).toBe('Yes, it will definitely arrive on time.');
  });
});
