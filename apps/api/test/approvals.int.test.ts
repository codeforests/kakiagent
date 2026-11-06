/**
 * Approval routes (APR-02, APR-04, APR-06; UC-22 5, 5a, 5c, 5d; FEAT-055 §3, §5.4; AC-1, AC-5–
 * AC-7, AC-9, AC-12): the queue, the detail and the decision, the sidebar's pending approval and
 * the hand-back during one.
 */
import { randomUUID } from 'node:crypto';
import { draftApproval, SAFE_DEFAULTS } from '@kaki/approvals';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import { ApprovalDetail, ApprovalList, ConversationThread } from '@kaki/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let fudge: string;
const cookies: Record<'owner' | 'mei' | 'raj' | 'other', string> = {
  owner: '',
  mei: '',
  raj: '',
  other: '',
};
const ids: Record<string, string> = {};
const published: { channel: string; payload: Record<string, unknown> }[] = [];

async function member(email: string, displayName: string, rights: boolean) {
  const u = await owner.query(
    `insert into users (email, display_name) values ($1, $2) returning id`,
    [email, displayName],
  );
  await owner.query(
    `insert into memberships (tenant_id, user_id, role, approval_rights) values ($1, $2, 'agent', $3)`,
    [TENANT_A, u.rows[0].id, rights],
  );
  return u.rows[0].id as string;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    publisher: {
      publish: async (channel: string, payload: unknown) =>
        void published.push({ channel, payload: payload as Record<string, unknown> }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ids.owner = (
    await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)
  ).rows[0].id;
  ids.mei = await member('mei@kaki-bakery.test', 'Mei Ling', false);
  ids.raj = await member('raj@kaki-bakery.test', 'Raj', true);
  cookies.owner = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookies.mei = await sessionCookie(tdb, 'mei@kaki-bakery.test');
  cookies.raj = await sessionCookie(tdb, 'raj@kaki-bakery.test');
  cookies.other = await sessionCookie(tdb, 'owner@second-tenant.test');
  const input = {
    type: 'product' as const,
    value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD' as const },
    gstTreatment: 'inclusive' as const,
  };
  const chunk = await prepareChunk(gatewayFromConfig({ provider: 'fake' }), TENANT_A, input);
  fudge = (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, ids.owner!), input, chunk),
    )
  ).id;
  await owner.query(`update facts set status = 'approved' where id = $1`, [fudge]);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from approvals`);
  published.length = 0;
});

/** A visitor conversation with one request, drafted as the agent's port does. */
async function pending(opts: { at?: Date; quantity?: string } = {}) {
  const visitorId = randomUUID();
  const v = tdb.zone('visitor');
  const conv = await withTenant(v, TENANT_A, (tx) => createConversation(tx, TENANT_A, visitorId));
  await withTenant(v, TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text: 'quote for 20 chocolate fudge cakes please',
      clientMessageId: randomUUID(),
    }),
  );
  const r = await withTenant(v, TENANT_A, (tx) =>
    draftApproval(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      request: { items: 'chocolate fudge cakes', quantity: opts.quantity ?? '20' },
      products: [
        {
          factId: fudge,
          version: 1,
          name: 'Chocolate fudge cake',
          unit: null,
          priceCents: 5500,
          gst: 'inclusive',
        },
      ],
      gst: 'inclusive',
      business: 'Kaki Bakery',
      rules: SAFE_DEFAULTS,
      rulesVersion: null,
      hours: null,
      ...(opts.at ? { now: opts.at } : {}),
    }),
  );
  return { conversationId: conv.id, id: r.approval.id, version: r.approval.version };
}

const get = (url: string, who = cookies.owner) =>
  app.inject({ method: 'GET', url, headers: { cookie: who } });
const decideAs = (who: string, id: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/approvals/${id}/decision`,
    headers: { cookie: who },
    payload,
  });

describe('the queue and the detail (AC-1, SCR-APP-017/018)', () => {
  it('lists breached and urgent first, then by SLA; detail has the excerpt and prices', async () => {
    const fresh = await pending();
    const breached = await pending({ at: new Date(Date.now() - 3 * 3_600_000) });
    const list = ApprovalList.parse((await get('/api/v1/approvals')).json());
    expect(list.pendingCount).toBe(2);
    expect(list.items.map((i) => i.id)).toEqual([breached.id, fresh.id]);
    expect(list.items[0]).toMatchObject({
      breached: true,
      headline: expect.stringContaining('20'),
    });

    const res = await get(`/api/v1/approvals/${fresh.id}`);
    expect(res.statusCode).toBe(200);
    const d = ApprovalDetail.parse(res.json());
    expect(d.excerpt.map((m) => m.body)).toContain('quote for 20 chocolate fudge cakes please');
    expect(d.prices).toEqual([expect.objectContaining({ factId: fudge, current: true })]);
    expect(d.draftTotals).toMatchObject({ subtotalCents: 110_000, totalCents: 110_000 });
    expect(d).toMatchObject({ canDecide: true, decision: null, status: 'pending' });
    // D8: an Agent without rights reads it, with no actions.
    expect(
      ApprovalDetail.parse((await get(`/api/v1/approvals/${fresh.id}`, cookies.mei)).json()),
    ).toMatchObject({ canDecide: false });
  });

  it("tenant B can't list, read or decide A's approvals (AC-12)", async () => {
    const a = await pending();
    expect(
      ApprovalList.parse((await get('/api/v1/approvals', cookies.other)).json()).items,
    ).toEqual([]);
    expect((await get(`/api/v1/approvals/${a.id}`, cookies.other)).statusCode).toBe(404);
    const r = await decideAs(cookies.other, a.id, { action: 'approve', version: a.version });
    expect(r.statusCode).toBe(404);
  });
});

describe('deciding (AC-5–AC-7, AC-9)', () => {
  it('Owner approves: 200, a quote card delivered and published, back to ai', async () => {
    const a = await pending();
    const res = await decideAs(cookies.owner, a.id, { action: 'approve', version: a.version });
    expect(res.statusCode).toBe(200);
    expect(ApprovalDetail.parse(res.json())).toMatchObject({
      status: 'approved',
      canDecide: false,
      decision: { by: { userId: ids.owner } },
    });
    const card = await owner.query(
      `select card from messages where conversation_id = $1 and card is not null`,
      [a.conversationId],
    );
    expect(card.rows[0].card).toMatchObject({ kind: 'quote', totals: { totalCents: 110_000 } });
    const status = await owner.query(`select status from conversations where id = $1`, [
      a.conversationId,
    ]);
    expect(status.rows[0].status).toBe('ai');
    expect(published.map((p) => p.payload.type)).toEqual(
      expect.arrayContaining(['message', 'conversation', 'approval']),
    );
  });

  it('an Agent without rights gets 403; one with rights edits and approves', async () => {
    const a = await pending();
    const no = await decideAs(cookies.mei, a.id, { action: 'approve', version: a.version });
    expect(no.statusCode).toBe(403);
    const terms = {
      lines: [
        {
          factId: fudge,
          factVersion: 1,
          label: 'Chocolate fudge cake',
          unit: null,
          quantity: 20,
          unitPriceCents: 5000,
        },
      ],
      discountPct: 5,
      note: 'Delivery on Friday morning.',
    };
    const ok = await decideAs(cookies.raj, a.id, {
      action: 'edit_approve',
      version: a.version,
      terms,
    });
    expect(ok.statusCode).toBe(200);
    expect(ApprovalDetail.parse(ok.json())).toMatchObject({
      status: 'edited_approved',
      finalTotals: { subtotalCents: 100_000, discountCents: 5_000, totalCents: 95_000 },
    });
  });

  it('edit_approve with nothing is 422; reject needs a reason', async () => {
    const a = await pending();
    const empty = await decideAs(cookies.owner, a.id, {
      action: 'edit_approve',
      version: a.version,
      terms: { lines: [], discountPct: 0, note: '' },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe('invalid_terms');
    const blank = await decideAs(cookies.owner, a.id, {
      action: 'reject',
      version: a.version,
      reason: ' ',
    });
    expect(blank.statusCode).toBe(400);
    const reject = await decideAs(cookies.owner, a.id, {
      action: 'reject',
      version: a.version,
      reason: 'Fully booked that week',
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toMatchObject({
      status: 'rejected',
      decision: { reason: 'Fully booked that week' },
    });
  });

  it('a second decider and a stale version get 409 already_decided naming the first', async () => {
    const a = await pending();
    const [x, y] = await Promise.all([
      decideAs(cookies.owner, a.id, { action: 'approve', version: a.version }),
      decideAs(cookies.raj, a.id, { action: 'approve', version: a.version }),
    ]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const lost = x.statusCode === 409 ? x : y;
    expect(lost.json()).toMatchObject({
      error: 'already_decided',
      approval: { decision: { by: { userId: expect.any(String) } } },
    });
    const decided = await owner.query(
      `select count(*)::int as n from audit_entries where event_type = 'approval.decided'
         and $1 = any(subject_refs)`,
      [`conversation:${a.conversationId}`],
    );
    expect(decided.rows[0].n).toBe(1);
    const cards = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1 and card is not null`,
      [a.conversationId],
    );
    expect(cards.rows[0].n).toBe(1);
    const b = await pending();
    const stale = await decideAs(cookies.owner, b.id, {
      action: 'approve',
      version: b.version + 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('already_decided');
  });

  it('an expired approval is 409 expired', async () => {
    const a = await pending();
    await owner.query(`update approvals set status = 'expired' where id = $1`, [a.id]);
    const res = await decideAs(cookies.owner, a.id, { action: 'approve', version: a.version });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('expired');
  });
});

describe('the inbox during an approval (§5.3; D5)', () => {
  it('the sidebar shows the pending approval; hand-back returns to waiting_approval', async () => {
    const a = await pending();
    const thread = ConversationThread.parse(
      (await get(`/api/v1/conversations/${a.conversationId}`)).json(),
    );
    expect(thread.sidebar.approval).toMatchObject({ id: a.id, status: 'pending' });
    const v = thread.conversation.version;
    const take = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${a.conversationId}/takeover`,
      headers: { cookie: cookies.owner },
      payload: { version: v },
    });
    expect(take.statusCode).toBe(200);
    const v2 = (
      await owner.query(`select version from conversations where id = $1`, [a.conversationId])
    ).rows[0].version;
    const back = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${a.conversationId}/handback`,
      headers: { cookie: cookies.owner },
      payload: { version: v2 },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().conversation.status).toBe('waiting_approval');
  });
});
