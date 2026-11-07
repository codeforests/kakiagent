/**
 * FEAT-051 through the real turn (§5.3; AC-2, AC-9): "stop using my details" stores the agent
 * reply with a withdraw card and writes no consent row; a deletion request escalates the
 * conversation with source `data_request` and replies with the fixed text.
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

async function chat(withContact: boolean) {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  if (withContact) {
    const k = await owner.query<{ id: string }>(
      `insert into contacts (tenant_id, name, email) values ($1, 'Mei', $2) returning id`,
      [TENANT_A, `${visitorId}@example.com`],
    );
    await owner.query(`update conversations set contact_id = $2 where id = $1`, [
      conv.id,
      k.rows[0]!.id,
    ]);
  }
  const say = async (text: string) => {
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
  };
  return { conversationId: conv.id, say };
}

const consents = async () =>
  (await owner.query(`select count(*)::int n from consents`)).rows[0].n as number;

describe('withdraw_consent in the visitor turn (AC-2)', () => {
  it('a held contact gets the withdraw card and its text; nothing is written', async () => {
    const c = await chat(true);
    const before = await consents();
    const r = await c.say('please stop using my details');
    expect(r?.dispatched).toEqual([{ task: 'withdraw_consent', index: 0, outcome: 'done' }]);
    expect(r?.message).toMatchObject({
      author: 'agent',
      card: { kind: 'withdraw', offers: false },
    });
    expect(r?.message.body).toMatch(/stop using your contact details\? Choose below\.$/);
    expect(r?.outcome).toBe('answered');
    expect(await consents()).toBe(before);
  });

  it('nothing held: the withdraw_none text and no card', async () => {
    const c = await chat(false);
    const r = await c.say("pls don't contact me");
    expect(r?.message.card).toBeNull();
    expect(r?.message.body).toMatch(/doesn't have contact details from you in this chat/);
  });
});

describe('data_request in the visitor turn (AC-9)', () => {
  it('escalates with source data_request and replies with the fixed text', async () => {
    const c = await chat(false);
    const r = await c.say('please delete my details');
    expect(r?.dispatched).toEqual([{ task: 'data_request', index: 0, outcome: 'done' }]);
    expect(r?.message.body).toMatch(/passed your request about your personal data/);
    const esc = await owner.query(`select source from escalations where conversation_id = $1`, [
      c.conversationId,
    ]);
    expect(esc.rows).toEqual([{ source: 'data_request' }]);
  });
});
