/**
 * Take over and hand back on the real schema (INB-02, INB-09, ADR-013 d2; FEAT-043 §5.1,
 * AC-1, AC-3–AC-9): one owner decided by the database, notices, staff messages, closes.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlreadyOwnerError,
  autoCloseIdle,
  closeByStaff,
  ConversationNotFoundError,
  createConversation,
  endAiConversation,
  endVisitorConversation,
  getThread,
  handBack,
  IllegalTransitionError,
  listConversations,
  NotOwnedError,
  NotOwnerError,
  OwnedError,
  ownerOf,
  requestHandover,
  sendStaffMessage,
  StateChangedError,
  takeOver,
  threadEvents,
  transition,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const MEI = '00000000-0000-4000-8000-0000000000a1';
const KEN = '00000000-0000-4000-8000-0000000000b2';

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

const status = async (id: string) =>
  (await owner.query(`select status, version from conversations where id = $1`, [id])).rows[0];
const ownerRows = async (id: string) =>
  (await owner.query(`select user_id from conversation_owners where conversation_id = $1`, [id]))
    .rows;
const audits = async (id: string) =>
  (
    await owner.query(
      `select event_type, actor_ref, payload, subject_refs from audit_entries
        where tenant_id = $1 and $2 = any(subject_refs) and event_type <> 'conversation.started'
        order by seq`,
      [TENANT_A, `conversation:${id}`],
    )
  ).rows;

const take = (
  id: string,
  userId = MEI,
  version = 0,
  extra: { from?: string; name?: string | null } = {},
) =>
  withTenant(dash(), TENANT_A, (tx) =>
    takeOver(tx, {
      tenantId: TENANT_A,
      conversationId: id,
      userId,
      visitorName: extra.name === undefined ? 'Mei Ling' : extra.name,
      version,
      ...(extra.from ? { from: extra.from } : {}),
    }),
  );

describe('take over (AC-1, AC-3, AC-5, AC-8)', () => {
  it.each(['ai', 'escalated', 'waiting_approval'] as const)(
    'from %s: human, one owner, one state_changed audit, a joined notice',
    async (from) => {
      const c = await started();
      if (from !== 'ai')
        await withTenant(dash(), TENANT_A, (tx) =>
          transition(tx, {
            tenantId: TENANT_A,
            conversationId: c.id,
            to: from,
            actor: { type: 'agent' },
          }),
        ).catch(async () => {
          await owner.query(`update conversations set status = $2 where id = $1`, [c.id, from]);
        });
      const v = (await status(c.id)).version;
      const out = await take(c.id, MEI, v);
      expect(out.conversation).toMatchObject({ status: 'human', version: v + 1 });
      expect(await ownerRows(c.id)).toEqual([{ user_id: MEI }]);
      expect(out.notice).toMatchObject({
        author: 'system',
        body: '',
        noticeKind: 'staff_joined',
        notice: 'Mei Ling joined the chat.',
        authorUserId: MEI,
        authorName: 'Mei Ling',
        language: 'en',
      });
      const states = (await audits(c.id)).filter((a) => a.payload?.to === 'human');
      expect(states).toEqual([
        expect.objectContaining({
          event_type: 'conversation.state_changed',
          actor_ref: MEI,
          payload: { from, to: 'human', reason: null },
        }),
      ]);
    },
  );

  it("the notice follows the conversation's language and falls back without a name", async () => {
    const c = await started();
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, language) values ($1, $2, 'agent', '你好', 'zh')`,
      [TENANT_A, c.id],
    );
    const out = await take(c.id, MEI, 0, { name: null });
    expect(out.notice).toMatchObject({
      notice: '团队成员已加入对话。',
      language: 'zh',
      authorName: null,
    });
  });

  it('two simultaneous take-overs: exactly one owner, the other told who', async () => {
    const c = await started();
    const results = await Promise.allSettled([
      take(c.id, MEI, 0),
      take(c.id, KEN, 0, { name: 'Ken' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(OwnedError);
    const rows = await ownerRows(c.id);
    expect(rows).toHaveLength(1);
    expect((lost.reason as OwnedError).owner.userId).toBe(rows[0].user_id);
    expect(await status(c.id)).toEqual({ status: 'human', version: 1 });
  });

  it('the owner again: already the owner; a closed conversation or stale version leaves no row', async () => {
    const c = await started();
    await take(c.id);
    await expect(take(c.id, MEI, 1)).rejects.toBeInstanceOf(AlreadyOwnerError);
    const stale = await started();
    await expect(take(stale.id, MEI, 7)).rejects.toBeInstanceOf(StateChangedError);
    expect(await ownerRows(stale.id)).toEqual([]);
    const closed = await started();
    await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: closed.id, userId: KEN, version: 0 }),
    );
    await expect(take(closed.id, MEI, 1)).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await ownerRows(closed.id)).toEqual([]);
  });

  it('from: moves ownership, audits owner_changed with IDs only; a stale from is refused', async () => {
    const c = await started();
    await take(c.id);
    const out = await take(c.id, KEN, 1, { from: MEI, name: 'Ken' });
    expect(out.previousOwner).toBe(MEI);
    expect(out.notice).toMatchObject({ notice: 'Ken joined the chat.', authorUserId: KEN });
    expect(await ownerRows(c.id)).toEqual([{ user_id: KEN }]);
    expect(await status(c.id)).toEqual({ status: 'human', version: 1 });
    const changed = (await audits(c.id)).filter(
      (a) => a.event_type === 'conversation.owner_changed',
    );
    expect(changed).toEqual([
      {
        event_type: 'conversation.owner_changed',
        actor_ref: KEN,
        payload: { from: 'human', to: 'human', reason: 'taken_from' },
        subject_refs: [`conversation:${c.id}`, `user:${MEI}`],
      },
    ]);
    expect(JSON.stringify(changed)).not.toMatch(/Mei|Ken/);
    // MEI no longer owns it: taking it "from" her names the current owner.
    const third = '00000000-0000-4000-8000-0000000000c3';
    const err = await take(c.id, third, 1, { from: MEI }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnedError);
    expect((err as OwnedError).owner.userId).toBe(KEN);
  });
});

describe('hand back, staff messages and requests (AC-1, AC-4, AC-6, AC-9)', () => {
  it('the owner hands back: ai, no row, a left notice; someone else is refused', async () => {
    const c = await started();
    await take(c.id);
    await expect(
      withTenant(dash(), TENANT_A, (tx) =>
        handBack(tx, { tenantId: TENANT_A, conversationId: c.id, userId: KEN, version: 1 }),
      ),
    ).rejects.toBeInstanceOf(NotOwnerError);
    const out = await withTenant(dash(), TENANT_A, (tx) =>
      handBack(tx, { tenantId: TENANT_A, conversationId: c.id, userId: MEI, version: 1 }),
    );
    expect(out.conversation).toMatchObject({ status: 'ai', version: 2 });
    expect(out.notice).toMatchObject({
      noticeKind: 'staff_left',
      notice: 'Mei Ling left the chat. The assistant will keep helping you.',
    });
    expect(await ownerRows(c.id)).toEqual([]);
    const events = await withTenant(dash(), TENANT_A, (tx) => threadEvents(tx, TENANT_A, c.id));
    expect(events.map((e) => e.reason)).toEqual(['taken_over', 'handed_back']);
  });

  it('a staff message by the owner is masked, idempotent and moves last_message_at', async () => {
    const c = await started();
    await take(c.id);
    await owner.query(
      `update conversations set last_message_at = now() - interval '20 minutes' where id = $1`,
      [c.id],
    );
    const send = (userId = MEI, clientMessageId = 'staff-0001') =>
      withTenant(dash(), TENANT_A, (tx) =>
        sendStaffMessage(tx, {
          tenantId: TENANT_A,
          conversationId: c.id,
          userId,
          body: 'Your NRIC S1234567D is noted',
          clientMessageId,
        }),
      );
    const first = await send();
    expect(first.created).toBe(true);
    expect(first.message).toMatchObject({
      author: 'staff',
      authorUserId: MEI,
      authorName: 'Mei Ling',
    });
    expect(first.message.body).not.toContain('S1234567D');
    const again = await send();
    expect(again).toEqual({ message: first.message, created: false });
    const idle = (
      await owner.query(
        `select now() - last_message_at < interval '1 minute' as fresh from conversations where id = $1`,
        [c.id],
      )
    ).rows[0];
    expect(idle).toEqual({ fresh: true });
    await expect(send(KEN, 'staff-0002')).rejects.toBeInstanceOf(NotOwnerError);
    const thread = await withTenant(dash(), TENANT_A, (tx) => getThread(tx, TENANT_A, c.id));
    expect(thread.messages.at(-1)).toMatchObject({
      author: 'staff',
      authorUserId: MEI,
      authorName: 'Mei Ling',
    });
  });

  it('a request needs an owner other than the caller and audits IDs only', async () => {
    const c = await started();
    const ask = (userId: string) =>
      withTenant(dash(), TENANT_A, (tx) =>
        requestHandover(tx, { tenantId: TENANT_A, conversationId: c.id, userId }),
      );
    await expect(ask(KEN)).rejects.toBeInstanceOf(NotOwnedError);
    await take(c.id);
    await expect(ask(MEI)).rejects.toBeInstanceOf(AlreadyOwnerError);
    expect(await ask(KEN)).toBe(MEI);
    const req = (await audits(c.id)).filter(
      (a) => a.event_type === 'conversation.handover_requested',
    );
    expect(req).toEqual([
      {
        event_type: 'conversation.handover_requested',
        actor_ref: KEN,
        payload: { reason: 'handover_requested' },
        subject_refs: [`conversation:${c.id}`, `user:${MEI}`],
      },
    ]);
    const events = await withTenant(dash(), TENANT_A, (tx) => threadEvents(tx, TENANT_A, c.id));
    expect(events.at(-1)).toMatchObject({
      reason: 'handover_requested',
      from: null,
      to: null,
      actor: { type: 'user', id: KEN },
      subject: { id: MEI },
    });
  });
});

describe('closes and the owner (AC-6, AC-8)', () => {
  it('only the owner closes; the close removes the owner', async () => {
    const c = await started();
    await take(c.id);
    const close = (userId: string) =>
      withTenant(dash(), TENANT_A, (tx) =>
        closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId, version: 1 }),
      );
    await expect(close(KEN)).rejects.toBeInstanceOf(OwnedError);
    await close(MEI);
    expect(await ownerRows(c.id)).toEqual([]);
  });

  it('auto-close, the visitor ending the chat and the abuse rule remove the owner', async () => {
    const idle = await started();
    await take(idle.id);
    await owner.query(
      `update conversations set last_message_at = now() - interval '31 minutes' where id = $1`,
      [idle.id],
    );
    await withTenant(visitor(), TENANT_A, (tx) => autoCloseIdle(tx, TENANT_A, idle.id));
    expect(await ownerRows(idle.id)).toEqual([]);

    const ended = await started();
    await take(ended.id);
    await withTenant(visitor(), TENANT_A, (tx) =>
      endVisitorConversation(tx, {
        tenantId: TENANT_A,
        conversationId: ended.id,
        visitorId: ended.visitorId,
      }),
    );
    expect(await ownerRows(ended.id)).toEqual([]);

    // The abuse rule ends only AI-handled chats; a stray owner row still goes with the close.
    const abuse = await started();
    await owner.query(
      `insert into conversation_owners (tenant_id, conversation_id, user_id) values ($1, $2, $3)`,
      [TENANT_A, abuse.id, MEI],
    );
    expect(
      await withTenant(visitor(), TENANT_A, (tx) =>
        endAiConversation(tx, TENANT_A, abuse.id, 'abuse'),
      ),
    ).toBe(true);
    expect(await ownerRows(abuse.id)).toEqual([]);
  });
});

describe('the assignee filter and tenants (AC-7, AC-9)', () => {
  it('filters by owner or none and carries the owner, named by the caller', async () => {
    const mine = await started();
    const theirs = await started();
    const nobody = await started();
    await take(mine.id);
    await take(theirs.id, KEN, 0, { name: 'Ken' });
    const list = (assignee?: { kind: 'user'; userId: string } | { kind: 'none' }) =>
      withTenant(dash(), TENANT_A, (tx) =>
        listConversations(
          tx,
          TENANT_A,
          { view: 'open', limit: 50, assignee },
          async (ids) => new Map(ids.map((id) => [id, id === MEI ? 'Mei Ling' : 'ken'])),
        ),
      );
    const ids = (r: Awaited<ReturnType<typeof list>>) => r.conversations.map((x) => x.id);
    const meiOnly = await list({ kind: 'user', userId: MEI });
    expect(ids(meiOnly)).toContain(mine.id);
    expect(ids(meiOnly)).not.toContain(theirs.id);
    expect(meiOnly.conversations.find((x) => x.id === mine.id)?.owner).toEqual({
      userId: MEI,
      name: 'Mei Ling',
    });
    const none = await list({ kind: 'none' });
    expect(ids(none)).toContain(nobody.id);
    expect(ids(none)).not.toContain(mine.id);
    expect(none.conversations.every((x) => x.owner === null)).toBe(true);
    const all = await list();
    expect(all.conversations.find((x) => x.id === theirs.id)?.owner).toEqual({
      userId: KEN,
      name: 'ken',
    });
    // The notice is the row's preview when it is the last message.
    expect(all.conversations.find((x) => x.id === theirs.id)?.lastMessage).toBe(
      'Ken joined the chat.',
    );
  });

  it("tenant B can't read, take over or write tenant A's conversation", async () => {
    const c = await started();
    await take(c.id);
    const b = await withTenant(dash(), TENANT_B, (tx) => ownerOf(tx, TENANT_B, c.id));
    expect(b).toBeNull();
    await expect(
      withTenant(dash(), TENANT_B, (tx) =>
        takeOver(tx, {
          tenantId: TENANT_B,
          conversationId: c.id,
          userId: KEN,
          visitorName: null,
          version: 1,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(dash(), TENANT_B, (tx) =>
        sendStaffMessage(tx, {
          tenantId: TENANT_B,
          conversationId: c.id,
          userId: MEI,
          body: 'hi',
          clientMessageId: 'cross-0001',
        }),
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await ownerRows(c.id)).toEqual([{ user_id: MEI }]);
  });
});
