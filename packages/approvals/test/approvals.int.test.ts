/**
 * Approvals on the real schema (APR-02, APR-04, APR-06; UC-22; FEAT-055 §5.1, §5.3; AC-1,
 * AC-3–AC-12): drafting, the queue, decisions and delivery, undeliverable, the timers, and
 * the hand-back into `waiting_approval`.
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { createConversation, handBack, takeOver, type TenantHours } from '@kaki/inbox';
import { WeeklyHours } from '@kaki/tenancy';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AlreadyDecided,
  ApprovalExpired,
  decide,
  draftApproval,
  InvalidTerms,
  listApprovals,
  pendingApprovalOf,
  runApprovalTimer,
  SAFE_DEFAULTS,
  summaryOf,
  totalsOf,
  type DraftInput,
  type PricedProduct,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let ownerId: string;
const ADMIN = '00000000-0000-4000-8000-0000000055a1';
const RIGHTS = '00000000-0000-4000-8000-0000000055a2';
const PLAIN = '00000000-0000-4000-8000-0000000055a3';

const BAKERY: TenantHours = {
  hours: WeeklyHours.parse({
    mon: [{ open: '08:00', close: '19:00' }],
    tue: [{ open: '08:00', close: '19:00' }],
    wed: [{ open: '08:00', close: '19:00' }],
    thu: [{ open: '08:00', close: '19:00' }],
    fri: [{ open: '08:00', close: '19:00' }],
    sat: [{ open: '09:00', close: '17:00' }],
    sun: [{ open: '09:00', close: '13:00' }],
  }),
  openOnPublicHolidays: false,
  holidays: {},
};
const at = (local: string) => new Date(`${local}+08:00`);
const vanilla: PricedProduct = {
  factId: '00000000-0000-4000-8000-0000000055f1',
  version: 2,
  name: 'Vanilla cupcake',
  unit: 'piece',
  priceCents: 350,
  gst: 'inclusive',
};

const vis = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('visitor'), TENANT_A, fn);
const dash = <T>(fn: (tx: Tx) => Promise<T>, tenant = TENANT_A) =>
  withTenant(tdb.zone('dashboard'), tenant, fn);

async function addMember(id: string, role: string, rights = false) {
  await owner.query(`insert into users (id, email) values ($1, $2)`, [id, `${id}@test.test`]);
  await owner.query(
    `insert into memberships (tenant_id, user_id, role, status, approval_rights) values ($1, $2, $3, 'active', $4)`,
    [TENANT_A, id, role, rights],
  );
}
const conversation = () => vis((tx) => createConversation(tx, TENANT_A, randomUUID()));
const input = (conversationId: string, over: Partial<DraftInput> = {}): DraftInput => ({
  tenantId: TENANT_A,
  conversationId,
  request: { items: '200 vanilla cupcakes', quantity: '200', discount: '15%' },
  products: [vanilla],
  gst: 'inclusive',
  business: 'Kaki Bakery',
  rules: { ...SAFE_DEFAULTS, maxDiscountPct: 10 },
  rulesVersion: 3,
  hours: BAKERY,
  now: at('2026-11-04T10:00:00'),
  ...over,
});
const draft = (conversationId: string, over: Partial<DraftInput> = {}) =>
  vis((tx) => draftApproval(tx, input(conversationId, over)));
const status = async (id: string) =>
  (await owner.query(`select status from conversations where id = $1`, [id])).rows[0].status;
const audits = async (conversationId: string) =>
  (
    await owner.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from audit_entries
       where tenant_id = $1 and event_type like 'approval.%' and subject_refs @> array[$2]::text[] order by seq`,
      [TENANT_A, `conversation:${conversationId}`],
    )
  ).rows;
const alerts = async (approvalId: string) =>
  (
    await owner.query<{ user_id: string; kind: string; urgent: boolean; status: string }>(
      `select user_id, kind, urgent, status from notifications where subject_id = $1 order by kind, user_id`,
      [approvalId],
    )
  ).rows;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  await addMember(ADMIN, 'admin');
  await addMember(RIGHTS, 'agent', true);
  await addMember(PLAIN, 'agent');
});
beforeEach(async () => {
  await owner.query(`update tenants set name = 'Kaki Bakery' where id = $1`, [TENANT_A]);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('drafting (AC-1, AC-3, AC-4, AC-11)', () => {
  it('writes one pending approval, moves to waiting_approval, audits codes only and alerts each approver', async () => {
    const conv = await conversation();
    const r = await draft(conv.id);
    expect(r.status).toBe('drafted');
    const a = r.approval;
    expect(a).toMatchObject({
      kind: 'discount',
      status: 'pending',
      aboveMax: true,
      afterHours: false,
      rulesVersion: 3,
      request: { items: '200 vanilla cupcakes', quantity: '200', date: null, discountPct: 15 },
      draft: {
        lines: [
          {
            factId: vanilla.factId,
            factVersion: 2,
            label: 'Vanilla cupcake',
            unit: 'piece',
            quantity: 200,
            unitPriceCents: 350,
          },
        ],
        discountPct: 15,
        note: '',
      },
      prices: [{ factId: vanilla.factId, version: 2, name: 'Vanilla cupcake', priceCents: 350 }],
    });
    // Wednesday 10:00 + 2 business hours; urgent 30 minutes before; expiry 7 days on.
    expect(a.slaDueAt.toISOString()).toBe(at('2026-11-04T12:00:00').toISOString());
    expect(a.urgentAt?.toISOString()).toBe(at('2026-11-04T11:30:00').toISOString());
    expect(a.expiresAt.toISOString()).toBe(at('2026-11-11T10:00:00').toISOString());
    expect(await status(conv.id)).toBe('waiting_approval');
    const entries = await audits(conv.id);
    expect(entries).toEqual([
      {
        event_type: 'approval.drafted',
        payload: {
          approvalId: a.id,
          kind: 'discount',
          aboveMax: true,
          afterHours: false,
          rulesVersion: 3,
        },
      },
    ]);
    const approvers = [ownerId, ADMIN, RIGHTS].sort();
    expect((await alerts(a.id)).map((n) => [n.user_id, n.kind, n.urgent])).toEqual(
      approvers.map((u) => [u, 'approval_pending', false]),
    );
  });

  it('after hours the SLA starts at the next opening; no hours saved means plain minutes', async () => {
    const late = await draft((await conversation()).id, { now: at('2026-11-14T18:00:00') });
    expect(late.approval.afterHours).toBe(true);
    // Saturday 18:00 is closed; Sunday opens 09:00, + 120 business minutes (8 Nov, Deepavali, would push it to Tuesday).
    expect(late.approval.slaDueAt.toISOString()).toBe(at('2026-11-15T11:00:00').toISOString());
    const plain = await draft((await conversation()).id, {
      hours: null,
      rules: { ...SAFE_DEFAULTS, approvalSlaMinutes: 20 },
      now: at('2026-11-14T18:00:00'),
    });
    expect(plain.approval.slaDueAt.toISOString()).toBe(at('2026-11-14T18:20:00').toISOString());
    // Within 30 minutes already: the first alert is urgent and there is no urgent timer.
    expect(plain.approval.urgentAt).toBeNull();
    expect((await alerts(plain.approval.id)).every((n) => n.urgent)).toBe(true);
  });

  it('a repeat while pending drafts nothing; an escalated conversation stays escalated', async () => {
    const conv = await conversation();
    const first = await draft(conv.id);
    const again = await draft(conv.id, { request: { items: 'a cake' } });
    expect(again).toMatchObject({ status: 'already_pending', approval: { id: first.approval.id } });
    expect((await audits(conv.id)).length).toBe(1);

    const esc = await conversation();
    await owner.query(`update conversations set status = 'escalated' where id = $1`, [esc.id]);
    const r = await draft(esc.id, { request: { date: 'Friday', items: 'deliver' } });
    expect(r.approval.kind).toBe('commitment');
    expect(await status(esc.id)).toBe('escalated');
  });

  it('D3: an allowed plain quote is sent at once, audited approval.auto; a date always waits', async () => {
    const conv = await conversation();
    const rules = { ...SAFE_DEFAULTS, maxDiscountPct: 10, quotesNeedApproval: false };
    const r = await draft(conv.id, {
      rules,
      request: { items: 'cupcakes', quantity: '10', discount: 5 },
    });
    expect(r.status).toBe('auto');
    if (r.status !== 'auto') return;
    expect(r.approval).toMatchObject({ status: 'approved', decidedBy: null });
    expect(r.approval.deliveredMessageId).toBe(r.message.id);
    expect(r.message.card).toMatchObject({
      kind: 'quote',
      approvalId: r.approval.id,
      totals: totalsOf(
        { lines: [{ quantity: 10, unitPriceCents: 350 }], discountPct: 5 },
        'inclusive',
      ),
    });
    expect(r.message.body).toContain('Total S$33.25 (incl. GST)');
    expect(await status(conv.id)).toBe('ai');
    expect((await audits(conv.id)).map((e) => e.event_type)).toEqual(['approval.auto']);

    const dated = await draft((await conversation()).id, {
      rules,
      request: { items: 'cupcakes', quantity: '10', date: 'Friday' },
    });
    expect(dated.status).toBe('drafted');
  });
});

describe('deciding and delivery (AC-5, AC-6, AC-7, AC-9, AC-10, AC-12)', () => {
  it('approve delivers one quote card in the transaction, returns to ai and cancels the alerts', async () => {
    const conv = await conversation();
    const { approval } = await draft(conv.id);
    const r = await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: approval.id,
        userId: RIGHTS,
        decision: { action: 'approve', version: 1 },
      }),
    );
    expect(r.approval).toMatchObject({ status: 'approved', decidedBy: RIGHTS, version: 2 });
    expect(r.approval.deliveredMessageId).toBe(r.message.id);
    expect(r.message).toMatchObject({ author: 'system' });
    expect(r.message.card).toMatchObject({
      kind: 'quote',
      totals: {
        subtotalCents: 70_000,
        discountCents: 10_500,
        totalCents: 59_500,
        gst: 'inclusive',
      },
    });
    expect(r.message.body).toContain("Here's your quote from Kaki Bakery:");
    expect(r.conversation?.status).toBe('ai');
    expect(await status(conv.id)).toBe('ai');
    expect((await alerts(approval.id)).every((n) => n.status === 'cancelled')).toBe(true);
    const decided = (await audits(conv.id)).at(-1)!;
    expect(decided).toEqual({
      event_type: 'approval.decided',
      payload: { approvalId: approval.id, outcome: 'approved', edited: false },
    });
  });

  it('edit and approve sends the edited terms; reject sends the notice and keeps the reason off the audit', async () => {
    const one = await conversation();
    const a = (await draft(one.id)).approval;
    const terms = {
      lines: [{ ...(a.draft as { lines: object[] }).lines[0], quantity: 180 } as never],
      discountPct: 10,
      note: 'Friday delivery is fine.',
    };
    const edited = await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: a.id,
        userId: ownerId,
        decision: { action: 'edit_approve', version: 1, terms },
      }),
    );
    expect(edited.approval.status).toBe('edited_approved');
    expect(edited.message.card).toMatchObject({ discountPct: 10, totals: { totalCents: 56_700 } });
    expect(edited.message.body).toContain('Friday delivery is fine.');

    const two = await conversation();
    const b = (await draft(two.id)).approval;
    await expect(
      dash((tx) =>
        decide(tx, {
          tenantId: TENANT_A,
          approvalId: b.id,
          userId: ownerId,
          decision: {
            action: 'edit_approve',
            version: 1,
            terms: { lines: [], discountPct: 0, note: ' ' },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidTerms);
    const rejected = await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: b.id,
        userId: ownerId,
        decision: { action: 'reject', version: 1, reason: 'Sold out that week, Mrs Tan' },
      }),
    );
    expect(rejected.approval).toMatchObject({
      status: 'rejected',
      reason: 'Sold out that week, Mrs Tan',
    });
    expect(rejected.message).toMatchObject({ noticeKind: 'approval_rejected', card: null });
    const all = JSON.stringify(await audits(two.id));
    expect(all).not.toContain('Sold out');
    expect(all).not.toMatch(/700|595|350/);
  });

  it('a closed conversation gets the quote and stays closed; with no email or phone it is undeliverable', async () => {
    const reach = await conversation();
    const a = (await draft(reach.id)).approval;
    const contact = await owner.query<{ id: string }>(
      `insert into contacts (tenant_id, name, email) values ($1, 'Mei', 'mei@example.com') returning id`,
      [TENANT_A],
    );
    await owner.query(
      `update conversations set status = 'closed', closed_at = now(), close_reason = 'staff', contact_id = $2 where id = $1`,
      [reach.id, contact.rows[0]!.id],
    );
    const r = await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: a.id,
        userId: ownerId,
        decision: { action: 'approve', version: 1 },
      }),
    );
    expect(r.approval.status).toBe('approved');
    expect(r.conversation).toBeNull();
    expect(await status(reach.id)).toBe('closed');

    const gone = await conversation();
    const b = (await draft(gone.id)).approval;
    await owner.query(
      `update conversations set status = 'closed', closed_at = now(), close_reason = 'inactive' where id = $1`,
      [gone.id],
    );
    const u = await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: b.id,
        userId: RIGHTS,
        decision: { action: 'reject', version: 1, reason: 'No' },
      }),
    );
    expect(u.approval).toMatchObject({ status: 'undeliverable', decidedBy: RIGHTS, reason: 'No' });
    expect(u.message.noticeKind).toBe('approval_rejected');
    const told = (await alerts(b.id)).filter((n) => n.kind === 'approval_undeliverable');
    expect(told.map((n) => n.user_id).sort()).toEqual([ownerId, ADMIN, RIGHTS].sort());
    expect((await audits(gone.id)).at(-1)!.payload).toMatchObject({ outcome: 'undeliverable' });
  });

  it('two decisions at once record one; a stale version and an expired approval are refused', async () => {
    const conv = await conversation();
    const a = (await draft(conv.id)).approval;
    const one = (userId: string) =>
      dash((tx) =>
        decide(tx, {
          tenantId: TENANT_A,
          approvalId: a.id,
          userId,
          decision: { action: 'approve', version: 1 },
        }),
      );
    const results = await Promise.allSettled([one(ownerId), one(RIGHTS)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AlreadyDecided);
    expect((lost.reason as AlreadyDecided).approval.decidedBy).not.toBeNull();
    expect((await audits(conv.id)).filter((e) => e.event_type === 'approval.decided')).toHaveLength(
      1,
    );
    const quotes = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1 and card->>'kind' = 'quote'`,
      [conv.id],
    );
    expect(quotes.rows[0].n).toBe(1);

    const stale = (await draft((await conversation()).id)).approval;
    await expect(
      dash((tx) =>
        decide(tx, {
          tenantId: TENANT_A,
          approvalId: stale.id,
          userId: ownerId,
          decision: { action: 'approve', version: 7 },
        }),
      ),
    ).rejects.toBeInstanceOf(AlreadyDecided);
    await expect(
      dash((tx) =>
        decide(tx, {
          tenantId: TENANT_A,
          approvalId: stale.id,
          userId: ownerId,
          decision: { action: 'approve', version: 1 },
          now: new Date(stale.expiresAt.getTime() + 1),
        }),
      ),
    ).rejects.toBeInstanceOf(ApprovalExpired);
  });

  it("tenant B can't see or decide tenant A's approval", async () => {
    const a = (await draft((await conversation()).id)).approval;
    const seen = await dash((tx) => listApprovals(tx, TENANT_B, { view: 'pending' }), TENANT_B);
    expect(seen.items.map((r) => r.id)).not.toContain(a.id);
    await expect(
      dash(
        (tx) =>
          decide(tx, {
            tenantId: TENANT_B,
            approvalId: a.id,
            userId: ownerId,
            decision: { action: 'approve', version: 1 },
          }),
        TENANT_B,
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('the queue', () => {
  it('lists pending ones breached and urgent first, and decided ones newest first', async () => {
    await owner.query(`delete from approvals where tenant_id = $1 and status = 'pending'`, [
      TENANT_A,
    ]);
    const now = at('2026-11-04T11:45:00');
    const calm = (await draft((await conversation()).id, { now: at('2026-11-04T11:00:00') }))
      .approval;
    const urgent = (await draft((await conversation()).id, { now: at('2026-11-04T09:50:00') }))
      .approval;
    const breached = (await draft((await conversation()).id, { now: at('2026-11-04T08:00:00') }))
      .approval;
    const list = await dash((tx) => listApprovals(tx, TENANT_A, { view: 'pending', now }));
    expect(list.items.map((r) => r.id)).toEqual([breached.id, urgent.id, calm.id]);
    expect(list.pendingCount).toBe(3);
    expect(summaryOf(list.items[0]!, now)).toMatchObject({
      breached: true,
      urgent: false,
      totalCents: 59_500,
    });
    expect(summaryOf(list.items[1]!, now)).toMatchObject({ breached: false, urgent: true });
    const decided = await dash((tx) => listApprovals(tx, TENANT_A, { view: 'decided' }));
    expect(decided.items.every((r) => r.status !== 'pending')).toBe(true);
    expect(decided.items.length).toBeGreaterThan(0);
  });
});

describe('timers (AC-8, AC-9)', () => {
  const timer = (approvalId: string, t: 'urgent' | 'sla' | 'expire') =>
    vis((tx) => runApprovalTimer(tx, { tenantId: TENANT_A, approvalId, timer: t, hours: null }));

  it('urgent alerts once more; sla escalates approval_sla; a decided approval does nothing', async () => {
    const conv = await conversation();
    const a = (await draft(conv.id)).approval;
    expect((await timer(a.id, 'urgent')).outcome).toBe('alerted');
    expect((await timer(a.id, 'urgent')).outcome).toBe('alerted');
    expect((await alerts(a.id)).filter((n) => n.urgent)).toHaveLength(3);
    const sla = await timer(a.id, 'sla');
    expect(sla.outcome).toBe('escalated');
    expect(await status(conv.id)).toBe('escalated');
    const esc = await owner.query(
      `select source, urgent from escalations where conversation_id = $1`,
      [conv.id],
    );
    expect(esc.rows).toEqual([{ source: 'approval_sla', urgent: true }]);

    await dash((tx) =>
      decide(tx, {
        tenantId: TENANT_A,
        approvalId: a.id,
        userId: ownerId,
        decision: { action: 'approve', version: 1 },
      }),
    );
    expect(await status(conv.id)).toBe('escalated'); // a decision leaves `escalated` alone
    expect((await timer(a.id, 'urgent')).outcome).toBe('skipped');
    expect((await timer(a.id, 'sla')).outcome).toBe('skipped');
    expect((await timer(a.id, 'expire')).outcome).toBe('skipped');
  });

  it('expire sends the notice once, returns to ai and cancels the alerts', async () => {
    const conv = await conversation();
    const a = (await draft(conv.id)).approval;
    // The sweep marks it (approvals_queue_due(), tested in the db suite).
    await owner.query(
      `update approvals set status = 'expired', version = version + 1 where id = $1`,
      [a.id],
    );
    const r = await timer(a.id, 'expire');
    expect(r.outcome).toBe('expired');
    expect(r.message).toMatchObject({ noticeKind: 'approval_expired' });
    expect(r.message?.notice).toContain('Our team will contact you');
    expect(await status(conv.id)).toBe('ai');
    expect((await alerts(a.id)).every((n) => n.status === 'cancelled')).toBe(true);
    expect((await timer(a.id, 'expire')).outcome).toBe('skipped');
    expect((await audits(conv.id)).map((e) => e.event_type)).toEqual([
      'approval.drafted',
      'approval.expired',
    ]);
    await expect(
      dash((tx) =>
        decide(tx, {
          tenantId: TENANT_A,
          approvalId: a.id,
          userId: ownerId,
          decision: { action: 'approve', version: 2 },
        }),
      ),
    ).rejects.toBeInstanceOf(ApprovalExpired);
  });
});

describe('hand-back during a pending approval (D5)', () => {
  it('lands in waiting_approval with a pending approval, ai without one', async () => {
    for (const pending of [true, false]) {
      const conv = await conversation();
      if (pending) await draft(conv.id);
      const v1 = (await owner.query(`select version from conversations where id = $1`, [conv.id]))
        .rows[0].version;
      await dash((tx) =>
        takeOver(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          userId: ownerId,
          visitorName: 'Mei',
          version: v1,
        }),
      );
      const v2 = (await owner.query(`select version from conversations where id = $1`, [conv.id]))
        .rows[0].version;
      const r = await dash((tx) =>
        handBack(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          userId: ownerId,
          version: v2,
          hasPendingApproval: async (t) => (await pendingApprovalOf(t, TENANT_A, conv.id)) !== null,
        }),
      );
      expect(r.conversation.status).toBe(pending ? 'waiting_approval' : 'ai');
      const owners = await owner.query(
        `select 1 from conversation_owners where conversation_id = $1`,
        [conv.id],
      );
      expect(owners.rowCount).toBe(0);
    }
  });
});
