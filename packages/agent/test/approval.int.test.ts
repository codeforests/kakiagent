/**
 * FEAT-055 through the real turn (§5.2; AC-1–AC-3, AC-11): a quote, discount or commitment
 * request is drafted in code through `request_commitment` and the dispatcher; the visitor gets
 * only the waiting notice (no reply model on a commitment-only turn), or with an answer the
 * notice after it; `allowed` sends a plain quote at once (D3); a repeat drafts nothing (D4).
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
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approvalNotice, fakeTriage, fakeVisitorResponder, runVisitorTurn } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let ownerId: string;
let fudgeId: string;
const embedder = gatewayFromConfig({ provider: 'fake' });
const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
// Mon 2 Nov 2026, 11:00 SGT.
const MON_11 = new Date('2026-11-02T03:00:00Z');
// Mon 2 Nov 2026, 22:00 SGT.
const MON_22 = new Date('2026-11-02T14:00:00Z');
const ALL_DAY = [{ open: '00:00', close: '24:00' }];
const NINE_SIX = [{ open: '09:00', close: '18:00' }];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const chunk = await prepareChunk(embedder, TENANT_A, FUDGE);
  const fact = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFact(dashboardKb(tx, TENANT_A, 'owner-1'), FUDGE, chunk),
  );
  fudgeId = (fact as { id: string }).id;
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
beforeEach(() => hours(ALL_DAY));
afterEach(async () => {
  await owner.query(`delete from boundary_rules`);
});

async function hours(day: { open: string; close: string }[]) {
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
}

async function save(rules: Partial<BoundaryRules>) {
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    saveRules(tx, TENANT_A, {
      expectedVersion: null,
      rules: { ...SAFE_DEFAULTS, ...rules },
      userId: ownerId,
    }),
  );
}

/** One visitor message and its turn; `conversationId` continues a conversation. */
async function ask(text: string, opts: { conversationId?: string; clock?: Date } = {}) {
  const visitorId = randomUUID();
  const conversationId =
    opts.conversationId ??
    (
      await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
        createConversation(tx, TENANT_A, visitorId),
      )
    ).id;
  const vid =
    (await owner.query(`select visitor_id from conversations where id = $1`, [conversationId]))
      .rows[0].visitor_id ?? visitorId;
  const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId,
      visitorId: vid,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  let replyCalls = 0;
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => {
      if (req.model === 'triage') return fakeTriage(req);
      replyCalls++;
      return fakeVisitorResponder(req);
    }),
  ]);
  const result = await runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm, clock: () => opts.clock ?? MON_11 },
    { tenantId: TENANT_A, conversationId, messageId: message.id },
  );
  return { conversationId, messageId: message.id, result, replyCalls: () => replyCalls };
}

const approvalsOf = async (conversationId: string) =>
  (
    await owner.query(
      `select status, kind, draft, prices, above_max, after_hours, sla_due_at, decided_by
         from approvals where conversation_id = $1 order by created_at`,
      [conversationId],
    )
  ).rows;

const messagesOf = async (conversationId: string) =>
  (
    await owner.query(
      `select author, body, notice_kind, notice, card, in_reply_to is not null as reply
         from messages where conversation_id = $1 and author <> 'visitor' order by seq`,
      [conversationId],
    )
  ).rows;

const auditsOf = async (conversationId: string, types: string[]) =>
  (
    await owner.query(
      `select event_type, payload from audit_entries
        where $1 = any(subject_refs) and event_type = any($2) order by seq`,
      [`conversation:${conversationId}`, types],
    )
  ).rows;

describe('a commitment-only turn (AC-1, AC-3)', () => {
  it('drafts one approval from the product facts and stores only the waiting notice, no reply model', async () => {
    const r = await ask("I'd like a quote for 200 chocolate fudge cakes please");
    expect(r.result?.plan?.tasks.map((t) => t.kind)).toEqual(['request_commitment']);
    expect(r.replyCalls()).toBe(0);
    const due = new Date('2026-11-02T05:00:00Z'); // 13:00 SGT: two business hours later
    const text = approvalNotice('en', {
      status: 'drafted',
      afterHours: false,
      dueAt: due,
      nextOpen: null,
      now: MON_11,
    });
    expect(text).toContain('1:00 pm today');
    expect(r.result).toMatchObject({ outcome: 'approval', route: null, approvalMessage: null });
    expect(r.result?.approval?.status).toBe('drafted');
    expect(r.result?.message).toMatchObject({
      author: 'system',
      body: '',
      noticeKind: 'approval_waiting',
      notice: text,
    });
    expect(r.result?.conversation.status).toBe('waiting_approval');

    const [a, ...more] = await approvalsOf(r.conversationId);
    expect(more).toEqual([]);
    expect(a).toMatchObject({
      status: 'pending',
      kind: 'quote',
      above_max: false,
      after_hours: false,
      decided_by: null,
    });
    expect(a.sla_due_at.toISOString()).toBe(due.toISOString());
    expect(a.draft.lines).toEqual([
      expect.objectContaining({ factId: fudgeId, quantity: 200, unitPriceCents: 5500 }),
    ]);
    expect(a.prices).toEqual([expect.objectContaining({ factId: fudgeId, priceCents: 5500 })]);
    // Nothing but the notice reached the visitor: no quote card, no total.
    expect(await messagesOf(r.conversationId)).toEqual([
      expect.objectContaining({
        author: 'system',
        body: '',
        notice_kind: 'approval_waiting',
        card: null,
        reply: true,
      }),
    ]);
    const audits = await auditsOf(r.conversationId, [
      'agent.dispatch',
      'approval.drafted',
      'agent.decision',
    ]);
    expect(audits.map((x) => x.event_type)).toEqual([
      'approval.drafted',
      'agent.dispatch',
      'agent.decision',
    ]);
    expect(audits[1].payload).toEqual({
      task: 'request_commitment',
      tool: 'draft_approval',
      outcome: 'done',
    });
    expect(audits[2].payload).toMatchObject({ outcome: 'approval', approval: 'drafted' });
    // ADR-014: codes and IDs only.
    expect(JSON.stringify(audits)).not.toMatch(/fudge|200|5500|S\$/i);
    const alerts = await owner.query(
      `select user_id, kind from notifications where subject_id = $1`,
      [
        a
          ? (
              await owner.query(`select id from approvals where conversation_id = $1`, [
                r.conversationId,
              ])
            ).rows[0].id
          : null,
      ],
    );
    expect(alerts.rows).toContainEqual({ user_id: ownerId, kind: 'approval_pending' });
  });

  it('a repeat while pending drafts nothing and says the team is still checking (D4)', async () => {
    const first = await ask("I'd like a quote for 200 chocolate fudge cakes please");
    const again = await ask('any discount for a bulk order', {
      conversationId: first.conversationId,
    });
    expect(again.replyCalls()).toBe(0);
    expect(again.result?.approval?.status).toBe('already_pending');
    expect(again.result?.message.notice).toMatch(/still checking your earlier request/);
    expect(await approvalsOf(first.conversationId)).toHaveLength(1);
  });

  it('after hours names the next business day and the opening time (UC-22 3a)', async () => {
    await hours(NINE_SIX);
    const r = await ask("I'd like a quote for 30 chocolate fudge cakes for friday please", {
      clock: MON_22,
    });
    expect(r.replyCalls()).toBe(0);
    expect(r.result?.outcome).toBe('approval');
    // Tue 09:00 SGT opens; two business hours later is 11:00.
    expect(r.result?.message.notice).toBe(
      approvalNotice('en', {
        status: 'drafted',
        afterHours: true,
        dueAt: new Date('2026-11-03T03:00:00Z'),
        nextOpen: new Date('2026-11-03T01:00:00Z'),
        now: MON_22,
      }),
    );
    expect(r.result?.message.notice).toContain('next business day');
    // No separate after-hours notice: the waiting notice already says when.
    expect(await messagesOf(r.conversationId)).toHaveLength(1);
    const [a] = await approvalsOf(r.conversationId);
    expect(a).toMatchObject({ after_hours: true });
  });

  it('a Chinese request gets the Chinese notice', async () => {
    const r = await ask('200个巧克力软糖蛋糕可以打折吗');
    expect(r.replyCalls()).toBe(0);
    expect(r.result?.message.notice).toContain('团队正在确认');
  });
});

describe('a question and a request in one message (§5.2)', () => {
  it('answers with the reply model, then stores the waiting notice after the reply', async () => {
    const r = await ask('How much is the chocolate fudge cake? Also a quote for 30 please');
    expect(r.result?.plan?.tasks.map((t) => t.kind)).toEqual(['answer', 'request_commitment']);
    expect(r.replyCalls()).toBeGreaterThan(0);
    expect(r.result?.outcome).toBe('answered');
    expect(r.result?.approvalNotice).toMatchObject({
      author: 'system',
      noticeKind: 'approval_waiting',
    });
    const msgs = await messagesOf(r.conversationId);
    expect(msgs.map((m) => [m.author, m.notice_kind, m.reply])).toEqual([
      ['agent', null, true],
      ['system', 'approval_waiting', false],
    ]);
    // FEAT-054's guard still holds: no discount or total in the model's text.
    expect(msgs[0].body).not.toMatch(/% off|discount/i);
  });
});

describe('quotes that need no approval (D3, AC-11)', () => {
  it('a plain matched quote is sent at once as a quote card, audited approval.auto', async () => {
    await save({ quotesNeedApproval: false, maxDiscountPct: 10 });
    const r = await ask("I'd like a quote for 2 chocolate fudge cakes please");
    expect(r.replyCalls()).toBe(0);
    expect(r.result?.approval?.status).toBe('auto');
    expect(r.result?.approvalMessage?.card).toMatchObject({
      kind: 'quote',
      totals: { subtotalCents: 11000, discountCents: 0, totalCents: 11000 },
    });
    expect(r.result?.conversation.status).toBe('ai');
    const msgs = await messagesOf(r.conversationId);
    expect(msgs.map((m) => [m.author, m.card?.kind ?? null, m.reply])).toEqual([
      ['system', 'quote', false],
      ['agent', null, true],
    ]);
    const [a] = await approvalsOf(r.conversationId);
    expect(a).toMatchObject({ status: 'approved', decided_by: null });
    const audits = await auditsOf(r.conversationId, ['approval.auto', 'approval.drafted']);
    expect(audits.map((x) => x.event_type)).toEqual(['approval.auto']);
  });

  it('a delivery date is a commitment and still waits (AGT-06)', async () => {
    await save({ quotesNeedApproval: false, maxDiscountPct: 10 });
    const r = await ask('a quote for 2 chocolate fudge cakes delivered tomorrow please');
    expect(r.result?.approval?.status).toBe('drafted');
    expect(r.result?.message.noticeKind).toBe('approval_waiting');
  });

  it('an above-maximum discount is drafted with aboveMax (D1)', async () => {
    await save({ quotesNeedApproval: false, maxDiscountPct: 10 });
    const r = await ask('a quote with 30% discount for 50 chocolate fudge cakes please');
    const [a] = await approvalsOf(r.conversationId);
    expect(a).toMatchObject({ status: 'pending', kind: 'discount', above_max: true });
  });
});
