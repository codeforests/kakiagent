/**
 * FEAT-038 through the real turn (§5.7; AC-9): "continue on Telegram" stores the agent reply
 * with a handoff card of the live channels and no reply-model call; beside a question the card
 * follows the answer; nothing live gives the `handoff_none` text. No handoff link is written.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import { createFakeProvider, createGateway, defaultRegistry } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeTriage, fakeVisitorResponder, runVisitorTurn } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
  // Telegram live with a bot; email not connected.
  const c = await owner.query<{ id: string }>(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
     values ($1, 'telegram', 'live', 'hidden', 'ok') returning id`,
    [TENANT_A],
  );
  await owner.query(
    `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name, webhook_secret_hash)
     values ($1, $2, 4242, 'kaki_bakery_bot', 'Kaki Bakery', $3)`,
    [TENANT_A, c.rows[0]!.id, Buffer.alloc(32)],
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const llm = createGateway(defaultRegistry('fake'), [
  createFakeProvider((req) =>
    req.model === 'triage' ? fakeTriage(req) : fakeVisitorResponder(req),
  ),
]);

async function say(text: string) {
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
  return runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm, clock: () => new Date('2026-11-04T03:00:00Z') },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
}

const links = async () =>
  (await owner.query(`select count(*)::int n from handoff_links`)).rows[0].n as number;

describe('handoff_channel in the visitor turn (AC-9)', () => {
  it('handoff only: the card of live channels with its text, no reply model, no link written', async () => {
    const r = await say('can we continue on telegram');
    expect(r?.dispatched).toEqual([{ task: 'handoff_channel', index: 0, outcome: 'done' }]);
    expect(r?.message).toMatchObject({
      author: 'agent',
      body: 'Sure. Where would you like to continue?',
      card: { kind: 'handoff', telegram: true, email: false },
    });
    expect(r?.route).toBeNull();
    expect(r?.outcome).toBe('answered');
    expect(await links()).toBe(0);
  });

  it('with a question: the answer comes first and the card follows it', async () => {
    const r = await say('what time do you open? and can we continue on telegram');
    expect(r?.route).not.toBeNull();
    expect(r?.message.card).toEqual({ kind: 'handoff', telegram: true, email: false });
    expect(r?.message.body).toMatch(/.+\s+Sure\. Where would you like to continue\?$/s);
  });

  it('nothing live: the handoff_none text and no card', async () => {
    await owner.query(
      `update channel_connections set state = 'offline' where tenant_id = $1 and kind = 'telegram'`,
      [TENANT_A],
    );
    const r = await say('can we continue on telegram');
    expect(r?.message.card).toBeNull();
    expect(r?.message.body).toBe('For now we can only chat here.');
  });
});
