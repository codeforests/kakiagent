/**
 * Escalations on the real schema (INB-05, UC-23 1–2; FEAT-044 §5.1, §5.2; AC-1, AC-3–AC-7):
 * routing, alerts, the notice, reminders and resolution by every path out of `escalated`.
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { WeeklyHours } from '@kaki/tenancy';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  autoCloseIdle,
  closeByStaff,
  ConversationClosedError,
  createConversation,
  endVisitorConversation,
  handBack,
  listConversations,
  queueAutoClose,
  queueEscalationReminders,
  remindEscalation,
  requestEscalation,
  takeOver,
  threadEvents,
  type EscalationNoticeText,
  type EscalationSource,
  type TenantHours,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
/** Tenant A's members: the seeded owner plus an agent and an admin; sorted by user ID. */
let members: { id: string; role: string }[];
const AGENT = '00000000-0000-4000-8000-0000000004a2';
const ADMIN = '00000000-0000-4000-8000-0000000004a3';
const B_AGENT = '00000000-0000-4000-8000-0000000004b2';

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
const noticeText: EscalationNoticeText = ({ afterHours, nextOpen, language }) =>
  afterHours ? `${language}:after:${nextOpen?.toISOString() ?? 'none'}` : `${language}:joining`;

async function addMember(tenantId: string, id: string, role: string) {
  await owner.query(`insert into users (id, email) values ($1, $2)`, [id, `${id}@test.test`]);
  await owner.query(
    `insert into memberships (tenant_id, user_id, role, status) values ($1, $2, $3, 'active')`,
    [tenantId, id, role],
  );
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await addMember(TENANT_A, AGENT, 'agent');
  await addMember(TENANT_A, ADMIN, 'admin');
  await addMember(TENANT_B, B_AGENT, 'agent');
  members = (
    await owner.query<{ id: string; role: string }>(
      `select user_id as id, role from memberships where tenant_id = $1 and status = 'active' order by user_id`,
      [TENANT_A],
    )
  ).rows;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from escalation_routing`);
});

const visitor = () => tdb.zone('visitor');
const dash = () => tdb.zone('dashboard');
const ownerId = () => members.find((m) => m.role === 'owner')!.id;

async function started(tenantId = TENANT_A) {
  const visitorId = randomUUID();
  const conv = await withTenant(visitor(), tenantId, (tx) =>
    createConversation(tx, tenantId, visitorId),
  );
  return { id: conv.id, visitorId };
}

const escalate = (
  id: string,
  opts: {
    source?: EscalationSource;
    hours?: TenantHours | null;
    now?: Date;
    tenantId?: string;
    withNotice?: boolean;
  } = {},
) =>
  withTenant(visitor(), opts.tenantId ?? TENANT_A, (tx) =>
    requestEscalation(tx, {
      tenantId: opts.tenantId ?? TENANT_A,
      conversationId: id,
      source: opts.source ?? 'visitor_button',
      hours: opts.hours ?? null,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.withNotice === false ? {} : { noticeText }),
    }),
  );

const remind = (escalationId: string, now?: Date, hours: TenantHours | null = null) =>
  withTenant(visitor(), TENANT_A, (tx) =>
    remindEscalation(tx, { tenantId: TENANT_A, escalationId, hours, ...(now ? { now } : {}) }),
  );

const alerts = async (id: string) =>
  (
    await owner.query<{
      user_id: string;
      kind: string;
      urgent: boolean;
      status: string;
      dedupe_key: string;
    }>(
      `select user_id, kind, urgent, status, dedupe_key from notifications
        where subject_id = $1 order by created_at, dedupe_key, user_id`,
      [id],
    )
  ).rows;
const escalationRows = async (id: string) =>
  (
    await owner.query(
      `select id, assignee_user_id, urgent, after_hours, reminders, next_reminder_at, resolved_at, resolution, resolved_by
         from escalations where conversation_id = $1 order by created_at`,
      [id],
    )
  ).rows;
const notices = async (id: string) =>
  (
    await owner.query(
      `select notice from messages where conversation_id = $1 and notice_kind = 'escalated' order by seq`,
      [id],
    )
  ).rows.map((r) => r.notice as string);
const setRouting = (mode: 'round_robin' | 'person', person: string | null, minutes = 10) =>
  owner.query(
    `insert into escalation_routing (tenant_id, mode, person_user_id, reminder_minutes) values ($1, $2, $3, $4)
     on conflict (tenant_id) do update set mode = excluded.mode, person_user_id = excluded.person_user_id,
       reminder_minutes = excluded.reminder_minutes`,
    [TENANT_A, mode, person, minutes],
  );
const take = (id: string, userId: string, version: number) =>
  withTenant(dash(), TENANT_A, (tx) =>
    takeOver(tx, { tenantId: TENANT_A, conversationId: id, userId, visitorName: 'Mei', version }),
  );
const version = async (id: string) =>
  (await owner.query(`select version from conversations where id = $1`, [id])).rows[0]
    .version as number;

describe('routing (§5.2; AC-3)', () => {
  it('round-robin hands each active member one in turn, wrapping', async () => {
    const got: (string | null)[] = [];
    for (let i = 0; i < members.length + 1; i++) {
      const c = await started();
      got.push((await escalate(c.id)).escalation!.assigneeUserId);
    }
    expect(members).toHaveLength(3);
    expect(got).toEqual([...members.map((m) => m.id), members[0]!.id]);
  });

  it('concurrent requests on two clients go to different members; one conversation gets one escalation', async () => {
    const [a, b] = [await started(), await started()];
    const [ra, rb] = await Promise.all([escalate(a.id), escalate(b.id)]);
    expect(ra.escalation!.assigneeUserId).not.toBe(rb.escalation!.assigneeUserId);
    const same = await started();
    const both = await Promise.all([escalate(same.id), escalate(same.id)]);
    expect(both.map((r) => r.status).sort()).toEqual(['already_escalated', 'escalated']);
    expect(await escalationRows(same.id)).toHaveLength(1);
    expect(await notices(same.id)).toHaveLength(1);
  });

  it('person mode always picks that person; an inactive person falls back to round-robin', async () => {
    await setRouting('person', AGENT);
    for (let i = 0; i < 2; i++) {
      const c = await started();
      expect((await escalate(c.id)).escalation!.assigneeUserId).toBe(AGENT);
    }
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [AGENT]);
    try {
      const c = await started();
      const assignee = (await escalate(c.id)).escalation!.assigneeUserId;
      expect(assignee).not.toBe(AGENT);
      expect(members.map((m) => m.id)).toContain(assignee);
    } finally {
      await owner.query(`update memberships set status = 'active' where user_id = $1`, [AGENT]);
    }
  });
});

describe('requesting (§5.1; AC-1, AC-4, AC-6)', () => {
  it('escalates once: state, alert, notice, audit with IDs and codes only', async () => {
    const c = await started();
    const r = await escalate(c.id);
    expect(r.status).toBe('escalated');
    expect(r.conversation.status).toBe('escalated');
    expect(r.notice?.notice).toBe('en:joining');
    const assignee = r.escalation!.assigneeUserId!;
    expect(await alerts(c.id)).toEqual([
      expect.objectContaining({ user_id: assignee, kind: 'escalation', urgent: true }),
    ]);
    const again = await escalate(c.id);
    expect(again).toMatchObject({ status: 'already_escalated', notice: null });
    expect(await alerts(c.id)).toHaveLength(1);
    expect(await notices(c.id)).toHaveLength(1);
    const audit = await owner.query(
      `select payload, subject_refs from audit_entries where event_type = 'escalation.assigned' and $1 = any(subject_refs)`,
      [`conversation:${c.id}`],
    );
    expect(audit.rows).toEqual([
      {
        payload: {
          escalationId: r.escalation!.id,
          source: 'visitor_button',
          urgent: true,
          afterHours: false,
        },
        subject_refs: [`conversation:${c.id}`, `user:${assignee}`],
      },
    ]);
  });

  it('an unverified escalation is quiet and has no notice; a visitor asking then makes it urgent once', async () => {
    const c = await started();
    const r = await escalate(c.id, { source: 'unverified', withNotice: false });
    expect(r.escalation!.urgent).toBe(false);
    expect(r.notice).toBeNull();
    expect(await escalate(c.id, { source: 'visitor_asked' })).toMatchObject({
      status: 'already_escalated',
      escalation: { urgent: true },
    });
    await escalate(c.id, { source: 'visitor_button' });
    const sent = await alerts(c.id);
    expect(sent.map((a) => [a.urgent, a.dedupe_key])).toEqual([
      [false, `escalation:${r.escalation!.id}`],
      [true, `escalation:${r.escalation!.id}:urgent`],
    ]);
    expect(await notices(c.id)).toEqual([]);
  });

  it('after hours: not urgent, the notice gives the next opening, the reminder clock starts at opening', async () => {
    const c = await started();
    const r = await escalate(c.id, { hours: BAKERY, now: at('2026-11-02T21:00') });
    expect(r.escalation).toMatchObject({ urgent: false, afterHours: true });
    expect(r.notice?.notice).toBe(`en:after:${at('2026-11-03T08:00').toISOString()}`);
    expect(r.escalation!.nextReminderAt!.toISOString()).toBe(at('2026-11-03T08:10').toISOString());
    // In hours it is urgent, and a later after-hours repeat doesn't upgrade a quiet one.
    const d = await started();
    const quiet = await escalate(d.id, {
      source: 'unverified',
      hours: BAKERY,
      now: at('2026-11-02T10:00'),
    });
    expect(quiet.escalation!.urgent).toBe(false);
    const late = await escalate(d.id, { hours: BAKERY, now: at('2026-11-02T22:00') });
    expect(late.escalation!.urgent).toBe(false);
  });

  it('with a person: nothing written; closed: refused', async () => {
    const c = await started();
    await take(c.id, AGENT, 0);
    expect(await escalate(c.id)).toMatchObject({ status: 'with_person', escalation: null });
    expect(await escalationRows(c.id)).toEqual([]);
    const d = await started();
    await withTenant(visitor(), TENANT_A, (tx) =>
      endVisitorConversation(tx, {
        tenantId: TENANT_A,
        conversationId: d.id,
        visitorId: d.visitorId,
      }),
    );
    await expect(escalate(d.id)).rejects.toBeInstanceOf(ConversationClosedError);
  });
});

describe('reminders (§5.1; AC-5)', () => {
  it('reminders 1–2 go to the assignee, from 3 to owners and admins too, every N business minutes', async () => {
    await setRouting('person', AGENT, 15);
    const c = await started();
    const r = await escalate(c.id);
    const id = r.escalation!.id;
    const t0 = new Date('2026-11-02T03:00:00Z');
    for (let n = 1; n <= 3; n++) expect(await remind(id, t0)).toBe('reminded');
    const reminders = (await alerts(c.id)).filter((a) => a.kind === 'escalation_reminder');
    const byN = (n: number) =>
      reminders
        .filter((a) => a.dedupe_key === `escalation:${id}:r${n}`)
        .map((a) => a.user_id)
        .sort();
    expect(byN(1)).toEqual([AGENT]);
    expect(byN(2)).toEqual([AGENT]);
    expect(byN(3)).toEqual([AGENT, ADMIN, ownerId()].sort());
    expect(reminders.every((a) => a.urgent)).toBe(true);
    const [row] = await escalationRows(c.id);
    expect(row.reminders).toBe(3);
    expect(row.next_reminder_at.toISOString()).toBe(
      new Date(t0.getTime() + 15 * 60_000).toISOString(),
    );
    // Business minutes with hours: from 18:55 the next reminder is the next morning.
    await remind(id, at('2026-11-02T18:55'), BAKERY);
    expect((await escalationRows(c.id))[0].next_reminder_at.toISOString()).toBe(
      at('2026-11-03T08:10').toISOString(),
    );
    const audit = await owner.query(
      `select payload from audit_entries where event_type = 'escalation.reminded' and $1 = any(subject_refs) order by seq`,
      [`conversation:${c.id}`],
    );
    expect(audit.rows.map((x) => x.payload)).toEqual(
      [1, 2, 3, 4].map((n) => ({ escalationId: id, n })),
    );
  });

  it('a deactivated assignee is re-routed at the next reminder', async () => {
    await setRouting('person', AGENT);
    const c = await started();
    const id = (await escalate(c.id)).escalation!.id;
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [AGENT]);
    try {
      expect(await remind(id)).toBe('reminded');
      const [row] = await escalationRows(c.id);
      expect(row.assignee_user_id).not.toBe(AGENT);
      expect((await alerts(c.id)).find((a) => a.kind === 'escalation_reminder')?.user_id).toBe(
        row.assignee_user_id,
      );
    } finally {
      await owner.query(`update memberships set status = 'active' where user_id = $1`, [AGENT]);
    }
  });

  it('a reminder after a stray claim resolves and sends nothing; a resolved one is skipped', async () => {
    const c = await started();
    const id = (await escalate(c.id)).escalation!.id;
    // An owner row written by a path that missed `transition` (the safety net).
    await owner.query(
      `insert into conversation_owners (tenant_id, conversation_id, user_id) values ($1, $2, $3)`,
      [TENANT_A, c.id, ADMIN],
    );
    expect(await remind(id)).toBe('resolved');
    expect((await escalationRows(c.id))[0]).toMatchObject({
      resolution: 'claimed',
      resolved_by: ADMIN,
    });
    expect(await remind(id)).toBe('skipped');
    expect((await alerts(c.id)).filter((a) => a.kind === 'escalation_reminder')).toEqual([]);
    expect((await alerts(c.id)).map((a) => a.status)).toEqual(['cancelled']);
  });

  it('the queue marks and queues each due escalation once', async () => {
    const c = await started();
    const id = (await escalate(c.id)).escalation!.id;
    await owner.query(
      `update escalations set next_reminder_at = now() - interval '1 second' where id = $1`,
      [id],
    );
    const first = await queueEscalationReminders(tdb.zone('outbox'));
    expect(first.find((q) => q.tenantId === TENANT_A)?.queued).toBeGreaterThanOrEqual(1);
    expect(await queueEscalationReminders(tdb.zone('outbox'))).toEqual([]);
    const job = await owner.query(
      `select group_key, payload from outbox where payload->>'escalationId' = $1`,
      [id],
    );
    expect(job.rows).toEqual([
      {
        group_key: c.id,
        payload: { kind: 'escalation_reminder', tenantId: TENANT_A, escalationId: id },
      },
    ]);
    expect((await escalationRows(c.id))[0].next_reminder_at).toBeNull();
  });

  it('auto-close skips an escalated conversation (D5)', async () => {
    const c = await started();
    await escalate(c.id);
    await owner.query(
      `update conversations set last_message_at = now() - interval '2 hours', auto_close_queued_at = null where id = $1`,
      [c.id],
    );
    await queueAutoClose(tdb.zone('outbox'));
    const row = await owner.query(`select auto_close_queued_at from conversations where id = $1`, [
      c.id,
    ]);
    expect(row.rows[0].auto_close_queued_at).toBeNull();
  });
});

describe('resolution in transition (§5.1; AC-5)', () => {
  const pendingAndHeld = async (id: string) => {
    // One held digest item as well as the pending alert.
    await owner.query(
      `update notifications set status = 'held', held_at = now() where subject_id = $1 and kind = 'escalation'`,
      [id],
    );
    const r = (await escalationRows(id))[0];
    await withTenant(visitor(), TENANT_A, (tx) =>
      remindEscalation(tx, { tenantId: TENANT_A, escalationId: r.id, hours: null }),
    );
  };

  it('take-over claims it and cancels pending and held alerts; hand-back leaves it resolved', async () => {
    const c = await started();
    await escalate(c.id);
    await pendingAndHeld(c.id);
    await take(c.id, ADMIN, await version(c.id));
    expect((await escalationRows(c.id))[0]).toMatchObject({
      resolution: 'claimed',
      resolved_by: ADMIN,
    });
    expect((await alerts(c.id)).map((a) => a.status)).toEqual(['cancelled', 'cancelled']);
    await withTenant(dash(), TENANT_A, (tx) =>
      handBack(tx, { tenantId: TENANT_A, conversationId: c.id, userId: ADMIN, version: 2 }),
    );
    expect(await escalationRows(c.id)).toEqual([
      expect.objectContaining({ resolution: 'claimed' }),
    ]);
  });

  it('each close path resolves it as closed', async () => {
    const staff = await started();
    await escalate(staff.id);
    await pendingAndHeld(staff.id);
    await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: staff.id, userId: ADMIN, version: 1 }),
    );
    expect((await escalationRows(staff.id))[0]).toMatchObject({
      resolution: 'closed',
      resolved_by: ADMIN,
    });
    expect((await alerts(staff.id)).every((a) => a.status === 'cancelled')).toBe(true);

    const ended = await started();
    await escalate(ended.id);
    await withTenant(visitor(), TENANT_A, (tx) =>
      endVisitorConversation(tx, {
        tenantId: TENANT_A,
        conversationId: ended.id,
        visitorId: ended.visitorId,
      }),
    );
    expect((await escalationRows(ended.id))[0]).toMatchObject({
      resolution: 'closed',
      resolved_by: null,
    });
    expect((await alerts(ended.id)).map((a) => a.status)).toEqual(['cancelled']);

    // Idle close isn't queued for an escalated conversation, but the worker's re-check would
    // still resolve it if a job were redelivered.
    const idle = await started();
    await escalate(idle.id);
    await owner.query(
      `update conversations set last_message_at = now() - interval '2 hours' where id = $1`,
      [idle.id],
    );
    await withTenant(visitor(), TENANT_A, (tx) => autoCloseIdle(tx, TENANT_A, idle.id));
    expect((await escalationRows(idle.id))[0]).toMatchObject({ resolution: 'closed' });
  });
});

describe('inbox views (§5.1; AC-7)', () => {
  it('the assignee filter matches the owner, else the open escalation assignee; summaries carry it', async () => {
    await setRouting('person', AGENT);
    const escalated = await started();
    await escalate(escalated.id);
    const owned = await started();
    await escalate(owned.id);
    await take(owned.id, ADMIN, await version(owned.id));
    const plain = await started();
    const names = async (ids: string[]) =>
      new Map(ids.map((id) => [id, id === AGENT ? 'Mei Ling' : 'Ken']));
    const list = (assignee: { kind: 'user'; userId: string } | { kind: 'none' }) =>
      withTenant(dash(), TENANT_A, (tx) =>
        listConversations(tx, TENANT_A, { view: 'open', assignee, limit: 50 }, names),
      ).then((r) => r.conversations);
    const forAgent = await list({ kind: 'user', userId: AGENT });
    expect(forAgent.map((x) => x.id)).toContain(escalated.id);
    expect(forAgent.map((x) => x.id)).not.toContain(owned.id);
    const row = forAgent.find((x) => x.id === escalated.id)!;
    expect(row.escalation).toMatchObject({
      assignee: { userId: AGENT, name: 'Mei Ling' },
      source: 'visitor_button',
      urgent: true,
      reminders: 0,
    });
    expect((await list({ kind: 'user', userId: ADMIN })).map((x) => x.id)).toContain(owned.id);
    const none = (await list({ kind: 'none' })).map((x) => x.id);
    expect(none).toContain(plain.id);
    expect(none).not.toContain(escalated.id);
    expect(none).not.toContain(owned.id);
    const ownedRow = (await list({ kind: 'user', userId: ADMIN })).find((x) => x.id === owned.id)!;
    expect(ownedRow.escalation).toBeNull();
  });

  it('the thread shows one "escalated" divider naming the assignee and the source', async () => {
    await setRouting('person', AGENT);
    const c = await started();
    await escalate(c.id, { source: 'visitor_asked' });
    const events = await withTenant(dash(), TENANT_A, (tx) => threadEvents(tx, TENANT_A, c.id));
    const escalated = events.filter((e) => e.to === 'escalated');
    expect(escalated).toEqual([
      expect.objectContaining({
        kind: 'state',
        reason: 'escalated',
        subject: { id: AGENT },
        source: 'visitor_asked',
        actor: { type: 'visitor', id: null },
      }),
    ]);
  });

  it("tenant B neither sees nor routes to tenant A's", async () => {
    const c = await started(TENANT_B);
    const r = await escalate(c.id, { tenantId: TENANT_B });
    expect(members.map((m) => m.id)).not.toContain(r.escalation!.assigneeUserId);
    const seen = await withTenant(visitor(), TENANT_A, (tx) =>
      tx.execute(sql`select id from escalations where conversation_id = ${c.id}`),
    );
    expect(seen.rows).toEqual([]);
  });
});
