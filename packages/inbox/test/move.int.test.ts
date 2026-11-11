/**
 * Moving a widget conversation to another channel (CHN-07; FEAT-038 §5.5, D2; AC-3, AC-7, AC-11).
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, moveConversation, threadEvents } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const MEI = '00000000-0000-4000-8000-0000000000a1';
const card = { kind: 'moved', channel: 'telegram', url: 'https://t.me/kaki_bot', sentTo: null };

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
     values ($1, 'telegram', 'live', 'hidden', 'ok')`,
    [TENANT_A],
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const visitor = () => tdb.zone('visitor');
const started = (tenantId = TENANT_A) =>
  withTenant(visitor(), tenantId, (tx) => createConversation(tx, tenantId, randomUUID(), 'widget'));
const move = (id: string, tenantId = TENANT_A) =>
  withTenant(visitor(), tenantId, (tx) =>
    moveConversation(tx, {
      tenantId,
      conversationId: id,
      to: 'telegram',
      notice: (l) =>
        l === 'zh' ? '此聊天将在 Telegram 上继续。' : 'This chat continues on Telegram.',
      card,
    }),
  );

describe('moveConversation (FEAT-038 §5.5)', () => {
  it('moves the same conversation once, keeps status and owner, stores an unsent notice and audits', async () => {
    const c = await started();
    await owner.query(`update conversations set status = 'human' where id = $1`, [c.id]);
    await owner.query(
      `insert into conversation_owners (tenant_id, conversation_id, user_id) values ($1, $2, $3)`,
      [TENANT_A, c.id, MEI],
    );
    const r = await move(c.id);
    expect(r?.conversation).toMatchObject({
      id: c.id,
      channel: 'telegram',
      status: 'human',
      version: c.version + 1,
    });
    expect(r?.notice).toMatchObject({
      author: 'system',
      noticeKind: 'handoff_moved',
      notice: 'This chat continues on Telegram.',
      card,
    });
    const owners = await owner.query(
      `select user_id from conversation_owners where conversation_id = $1`,
      [c.id],
    );
    expect(owners.rows).toEqual([{ user_id: MEI }]);
    // Stored while still on the widget: the delivery trigger skipped it.
    const deliveries = await owner.query(
      `select 1 from message_deliveries where conversation_id = $1`,
      [c.id],
    );
    expect(deliveries.rowCount).toBe(0);
    const events = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      threadEvents(tx, TENANT_A, c.id),
    );
    expect(events.filter((e) => e.kind === 'moved')).toEqual([
      expect.objectContaining({
        kind: 'moved',
        channel: 'telegram',
        actor: { type: 'visitor', id: null },
      }),
    ]);
    expect(await move(c.id)).toBeNull();
  });

  it("only from the widget, and never another tenant's conversation", async () => {
    const c = await started();
    await owner.query(`update conversations set channel = 'email' where id = $1`, [c.id]);
    expect(await move(c.id)).toBeNull();
    const b = await started(TENANT_B);
    expect(await move(b.id, TENANT_A)).toBeNull();
    const { rows } = await owner.query(`select channel from conversations where id = $1`, [b.id]);
    expect(rows[0].channel).toBe('widget');
  });
});
