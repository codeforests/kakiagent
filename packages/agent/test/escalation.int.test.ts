/**
 * FEAT-044 through the real turn (§5.4; AC-2, AC-4, AC-8): a visitor asking for a person in
 * words escalates through triage's `escalate` task and the dispatcher; answer tasks are still
 * answered; a reply that failed verification twice escalates quietly.
 */
import { randomUUID } from 'node:crypto';
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
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  escalationNotice,
  fakeTriage,
  fakeVisitorResponder,
  runVisitorTurn,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let ownerId: string;
const embedder = gatewayFromConfig({ provider: 'fake' });
const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const chunk = await prepareChunk(embedder, TENANT_A, FUDGE);
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFact(dashboardKb(tx, TENANT_A, 'owner-1'), FUDGE, chunk),
  );
  ownerId = (
    await owner.query(`select user_id from memberships where tenant_id = $1 and role = 'owner'`, [
      TENANT_A,
    ])
  ).rows[0].user_id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});

async function ask(text: string, responder: FakeScript = fakeVisitorResponder) {
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
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => (req.model === 'triage' ? fakeTriage(req) : responder(req))),
  ]);
  const run = () =>
    runVisitorTurn(
      { zdb: tdb.zone('visitor'), llm, clock: () => new Date('2026-11-02T03:00:00Z') },
      { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
    );
  return { conversationId: conv.id, messageId: message.id, result: await run(), run };
}

const state = async (conversationId: string) => {
  const c = await owner.query(`select status from conversations where id = $1`, [conversationId]);
  const e = await owner.query(
    `select source, urgent, assignee_user_id from escalations where conversation_id = $1`,
    [conversationId],
  );
  const n = await owner.query(
    `select user_id, kind, urgent from notifications where subject_id = $1`,
    [conversationId],
  );
  const m = await owner.query(
    `select author, body, notice_kind, in_reply_to is not null as reply from messages
      where conversation_id = $1 and author <> 'visitor' order by seq`,
    [conversationId],
  );
  return { status: c.rows[0].status, escalations: e.rows, alerts: n.rows, messages: m.rows };
};

describe('asking for a person in words (AC-2)', () => {
  it('escalate-only: the notice is the reply, with an assignee and one urgent alert', async () => {
    const r = await ask('can I talk to a person');
    expect(r.result).toMatchObject({ outcome: 'escalated', route: null, escalationNotice: null });
    expect(r.result?.plan?.tasks.map((t) => t.kind)).toEqual(['escalate']);
    expect(r.result?.message).toMatchObject({
      author: 'system',
      body: '',
      noticeKind: 'escalated',
      notice: escalationNotice('en', false, null, new Date()),
    });
    expect(r.result?.conversation.status).toBe('escalated');
    const s = await state(r.conversationId);
    expect(s.status).toBe('escalated');
    expect(s.escalations).toEqual([
      { source: 'visitor_asked', urgent: true, assignee_user_id: ownerId },
    ]);
    expect(s.alerts).toEqual([{ user_id: ownerId, kind: 'escalation', urgent: true }]);
    // One message only: the notice, replying to the visitor's (no agent text).
    expect(s.messages).toEqual([
      { author: 'system', body: '', notice_kind: 'escalated', reply: true },
    ]);
    const audits = await owner.query(
      `select event_type, payload from audit_entries where $1 = any(subject_refs)
        and event_type in ('agent.dispatch', 'escalation.assigned', 'agent.decision') order by seq`,
      [`conversation:${r.conversationId}`],
    );
    expect(audits.rows.map((a) => a.event_type)).toEqual([
      'escalation.assigned',
      'agent.dispatch',
      'agent.decision',
    ]);
    expect(audits.rows[1].payload).toEqual({ task: 'escalate', outcome: 'done' });
    expect(audits.rows[2].payload).toMatchObject({ outcome: 'escalated', tasks: ['escalate'] });
    // A redelivered job does nothing more.
    expect(await r.run()).toBeNull();
    expect((await state(r.conversationId)).alerts).toHaveLength(1);
  });

  it('in Chinese the notice is in Chinese', async () => {
    const r = await ask('我想转人工');
    expect(r.result?.message.notice).toBe(escalationNotice('zh', false, null, new Date()));
    expect((await state(r.conversationId)).status).toBe('escalated');
  });

  it('with a question: answered, and escalated with a separate notice', async () => {
    const r = await ask('how much is the fudge cake? can someone call me');
    expect(r.result?.plan?.tasks.map((t) => t.kind).sort()).toEqual(['answer', 'escalate']);
    expect(r.result?.outcome).toBe('answered');
    expect(r.result?.message.body).toContain('S$55.00');
    expect(r.result?.escalationNotice).toMatchObject({ noticeKind: 'escalated' });
    const s = await state(r.conversationId);
    expect(s.status).toBe('escalated');
    expect(s.messages.map((m) => [m.author, m.notice_kind, m.reply])).toEqual([
      ['system', 'escalated', false],
      ['agent', null, true],
    ]);
  });

  it('two failed verifications: escalated as unverified, not urgent, no notice', async () => {
    const r = await ask(
      'how much is the fudge cake',
      scriptedOutputs(['It is S$50.', 'Only $45 lah.']),
    );
    expect(r.result?.outcome).toBe('escalated');
    expect(r.result?.conversation.status).toBe('escalated');
    const s = await state(r.conversationId);
    expect(s.escalations).toEqual([
      { source: 'unverified', urgent: false, assignee_user_id: ownerId },
    ]);
    expect(s.alerts).toEqual([{ user_id: ownerId, kind: 'escalation', urgent: false }]);
    expect(s.messages.map((m) => m.notice_kind)).toEqual([null]);
  });
});
