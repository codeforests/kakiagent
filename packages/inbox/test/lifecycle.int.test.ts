/**
 * The conversation lifecycle on the real schema (INB-08, ADR-013 d1; FEAT-042 §5.1,
 * AC-5–AC-9): compare-and-set transitions, one audit entry each, auto-close and reopen.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlreadyClosedError,
  appendVisitorMessage,
  autoCloseIdle,
  closeByStaff,
  ConversationClosedError,
  ConversationNotFoundError,
  createConversation,
  endAiConversation,
  endVisitorConversation,
  IllegalTransitionError,
  queueAutoClose,
  StateChangedError,
  transition,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const visitor = () => tdb.zone('visitor');
const dash = () => tdb.zone('dashboard');

async function started(tenantId = TENANT_A) {
  const visitorId = randomUUID();
  const conv = await withTenant(visitor(), tenantId, (tx) =>
    createConversation(tx, tenantId, visitorId),
  );
  return { id: conv.id, visitorId };
}

const say = (c: { id: string; visitorId: string }, text: string) =>
  withTenant(visitor(), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: c.id,
      visitorId: c.visitorId,
      text,
      clientMessageId: `c-${randomUUID()}`,
    }),
  );

const row = async (id: string) =>
  (
    await owner.query(
      `select status, version, close_reason, closed_at from conversations where id = $1`,
      [id],
    )
  ).rows[0];

const lifecycleAudits = async (id: string) =>
  (
    await owner.query(
      `select event_type, actor_type, actor_ref, payload from audit_entries
        where tenant_id = $1 and $2 = any(subject_refs) and event_type <> 'conversation.started'
          and event_type like 'conversation.%' order by seq`,
      [TENANT_A, `conversation:${id}`],
    )
  ).rows;

const ageBy = (id: string, minutes: number) =>
  owner.query(
    `update conversations set last_message_at = now() - make_interval(mins => $2) where id = $1`,
    [id, minutes],
  );

describe('transitions (AC-5, AC-8)', () => {
  it('staff close: one audit entry with codes only, version bumped', async () => {
    const c = await started();
    const closed = await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version: 0 }),
    );
    expect(closed).toMatchObject({ status: 'closed', version: 1, closeReason: 'staff' });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(await lifecycleAudits(c.id)).toEqual([
      {
        event_type: 'conversation.closed',
        actor_type: 'user',
        actor_ref: USER,
        payload: { from: 'ai', to: 'closed', reason: 'staff' },
      },
    ]);
  });

  it('two simultaneous closes with one version: exactly one succeeds', async () => {
    const c = await started();
    const close = () =>
      withTenant(dash(), TENANT_A, (tx) =>
        closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version: 0 }),
      );
    const results = await Promise.allSettled([close(), close()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(StateChangedError);
    expect((failed.reason as StateChangedError).conversation).toMatchObject({
      status: 'closed',
      version: 1,
    });
    expect(await lifecycleAudits(c.id)).toHaveLength(1);
  });

  it('closing a closed conversation at its current version is already_closed', async () => {
    const c = await started();
    const close = (version: number) =>
      withTenant(dash(), TENANT_A, (tx) =>
        closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version }),
      );
    await close(0);
    await expect(close(1)).rejects.toBeInstanceOf(AlreadyClosedError);
    await expect(close(0)).rejects.toBeInstanceOf(StateChangedError);
  });

  it('refuses edges outside the table, and leaves the row and audit untouched', async () => {
    const c = await started();
    await owner.query(`update conversations set status = 'human' where id = $1`, [c.id]);
    await expect(
      withTenant(visitor(), TENANT_A, (tx) =>
        transition(tx, {
          tenantId: TENANT_A,
          conversationId: c.id,
          to: 'escalated',
          actor: { type: 'agent' },
        }),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await row(c.id)).toMatchObject({ status: 'human', version: 0 });
    expect(await lifecycleAudits(c.id)).toEqual([]);
  });

  it("later features' edges audit as state_changed", async () => {
    const c = await started();
    await withTenant(visitor(), TENANT_A, (tx) =>
      transition(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        to: 'escalated',
        actor: { type: 'agent' },
      }),
    );
    expect(await lifecycleAudits(c.id)).toEqual([
      {
        event_type: 'conversation.state_changed',
        actor_type: 'agent',
        actor_ref: null,
        payload: { from: 'ai', to: 'escalated', reason: null },
      },
    ]);
  });

  it("tenant B can't see or close tenant A's conversation (AC-9)", async () => {
    const c = await started();
    await expect(
      withTenant(dash(), TENANT_B, (tx) =>
        closeByStaff(tx, { tenantId: TENANT_B, conversationId: c.id, userId: USER, version: 0 }),
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await row(c.id)).toMatchObject({ status: 'ai', version: 0 });
  });
});

describe('reopen (AC-7)', () => {
  it('a visitor message within 7 days of a staff close reopens the same conversation', async () => {
    const c = await started();
    await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version: 0 }),
    );
    const res = await say(c, 'one more question');
    expect(res.created).toBe(true);
    expect(res.conversation).toMatchObject({ id: c.id, status: 'ai', closeReason: null });
    expect(await row(c.id)).toMatchObject({ status: 'ai', version: 2, closed_at: null });
    const audits = await lifecycleAudits(c.id);
    expect(audits.at(-1)).toEqual({
      event_type: 'conversation.reopened',
      actor_type: 'visitor',
      actor_ref: c.visitorId,
      payload: { from: 'closed', to: 'ai', reason: 'reopened' },
    });
    const turns = await owner.query(
      `select payload from outbox where group_key = $1 and payload ? 'messageId'`,
      [c.id],
    );
    expect(turns.rows.map((r) => r.payload.messageId)).toContain(res.message.id);
  });

  it('after 7 days the message is refused', async () => {
    const c = await started();
    await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version: 0 }),
    );
    await owner.query(
      `update conversations set closed_at = now() - interval '7 days 1 minute' where id = $1`,
      [c.id],
    );
    await expect(say(c, 'hello again')).rejects.toBeInstanceOf(ConversationClosedError);
  });

  it('a chat the visitor ended stays ended', async () => {
    const c = await started();
    await withTenant(visitor(), TENANT_A, (tx) =>
      endVisitorConversation(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        visitorId: c.visitorId,
      }),
    );
    await expect(say(c, 'wait')).rejects.toBeInstanceOf(ConversationClosedError);
    expect(await row(c.id)).toMatchObject({ status: 'closed', close_reason: 'visitor' });
  });

  // Acceptance verification: AC-7's inactivity-close and abuse-ended clauses.
  it('a visitor message within 7 days of an inactivity close reopens the same conversation', async () => {
    const c = await started();
    await ageBy(c.id, 31);
    await withTenant(visitor(), TENANT_A, (tx) => autoCloseIdle(tx, TENANT_A, c.id));
    const res = await say(c, 'back again');
    expect(res.conversation).toMatchObject({ id: c.id, status: 'ai', closeReason: null });
    expect((await lifecycleAudits(c.id)).at(-1)).toMatchObject({
      event_type: 'conversation.reopened',
      payload: { from: 'closed', to: 'ai', reason: 'reopened' },
    });
  });

  it('a chat the abuse rule ended stays ended', async () => {
    const c = await started();
    await withTenant(visitor(), TENANT_A, (tx) => endAiConversation(tx, TENANT_A, c.id, 'abuse'));
    await expect(say(c, 'let me back in')).rejects.toBeInstanceOf(ConversationClosedError);
    expect(await row(c.id)).toMatchObject({ status: 'closed', close_reason: 'abuse' });
  });
});

describe('auto-close (AC-6)', () => {
  const autoClose = (id: string) =>
    withTenant(visitor(), TENANT_A, (tx) => autoCloseIdle(tx, TENANT_A, id));

  it('closes a widget conversation idle 31 minutes, not one idle 29', async () => {
    const idle = await started();
    const fresh = await started();
    await ageBy(idle.id, 31);
    await ageBy(fresh.id, 29);
    expect(await autoClose(fresh.id)).toBeNull();
    expect(await autoClose(idle.id)).toMatchObject({ status: 'closed', closeReason: 'inactive' });
    expect(await autoClose(idle.id)).toBeNull();
    expect(await lifecycleAudits(idle.id)).toEqual([
      {
        event_type: 'conversation.auto_closed',
        actor_type: 'system',
        actor_ref: null,
        payload: { from: 'ai', to: 'closed', reason: 'inactive' },
      },
    ]);
    // Acceptance verification (AC-6): auto-close posts no message to the visitor.
    const msgs = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1`,
      [idle.id],
    );
    expect(msgs.rows[0].n).toBe(0);
    expect(await row(fresh.id)).toMatchObject({ status: 'ai' });
  });

  it('closes from any open state, and not after a new message', async () => {
    const escalated = await started();
    await owner.query(`update conversations set status = 'escalated' where id = $1`, [
      escalated.id,
    ]);
    await ageBy(escalated.id, 45);
    expect(await autoClose(escalated.id)).toMatchObject({ status: 'closed' });

    const talking = await started();
    await ageBy(talking.id, 45);
    await say(talking, 'still here');
    expect(await autoClose(talking.id)).toBeNull();
  });

  it('the scan queues a due conversation once, and the job closes it', async () => {
    const c = await started();
    await ageBy(c.id, 31);
    const outbox = tdb.zone('outbox');
    const first = await queueAutoClose(outbox);
    expect(first.find((r) => r.tenantId === TENANT_A)?.queued).toBeGreaterThanOrEqual(1);
    const jobs = await owner.query(
      `select payload from outbox where group_key = $1 and payload ->> 'kind' = 'auto_close'`,
      [c.id],
    );
    expect(jobs.rows).toEqual([
      { payload: { kind: 'auto_close', tenantId: TENANT_A, conversationId: c.id } },
    ]);
    await queueAutoClose(outbox);
    const again = await owner.query(
      `select count(*)::int as n from outbox where group_key = $1 and payload ->> 'kind' = 'auto_close'`,
      [c.id],
    );
    expect(again.rows[0].n).toBe(1);
    expect(await autoClose(c.id)).toMatchObject({ status: 'closed', closeReason: 'inactive' });
    // A closed conversation is never queued again.
    await queueAutoClose(outbox);
    expect(
      (
        await owner.query(
          `select count(*)::int as n from outbox where group_key = $1 and payload ->> 'kind' = 'auto_close'`,
          [c.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
