/**
 * FEAT-049 through the real turn (§5.3; AC-7, AC-8): `capture_lead` before consent gets the
 * consent card, after it the lead form with the valid args only; replies the AI couldn't help
 * with offer consent once per conversation, never after a decline or on a safety turn, and
 * never without a saved purpose statement. The turn itself stores no lead.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import { leadCaptureConfig, recordConsent } from '@kaki/leads';
import { createFakeProvider, createGateway, defaultRegistry } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeTriage, fakeVisitorResponder, runVisitorTurn } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let ownerId: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});
afterEach(async () => {
  await owner.query(`delete from consents`);
  await owner.query(`delete from privacy_settings`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const savePurpose = () =>
  withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: ownerId,
      version: 0,
      purpose: { en: 'To reply to you.', zh: null },
    }),
  );

const llm = createGateway(defaultRegistry('fake'), [
  createFakeProvider((req) =>
    req.model === 'triage' ? fakeTriage(req) : fakeVisitorResponder(req),
  ),
]);

async function chat() {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
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
  const answer = async (agreed: boolean) => {
    const config = (await withTenant(tdb.zone('visitor'), TENANT_A, leadCaptureConfig))!;
    return withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      recordConsent(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        purposeWordingId: config.purpose.wordingId,
        agreed,
      }),
    );
  };
  return { conversationId: conv.id, say, answer };
}

const decisionCard = async (messageId: string) =>
  (
    await owner.query(
      `select payload->>'card' as card from audit_entries
       where event_type = 'agent.decision' and subject_refs @> array[$1]::text[]`,
      [`message:${messageId}`],
    )
  ).rows[0]?.card ?? null;

describe('capture_lead in the visitor turn (AC-7)', () => {
  it('before consent: the consent card, prefilled with the valid args; after: the form', async () => {
    await savePurpose();
    const c = await chat();
    const first = await c.say('My number is 9123 4567, please call me back');
    expect(first?.dispatched).toEqual([
      { task: 'capture_lead', index: 0, outcome: 'refused', reason: 'consent' },
    ]);
    expect(first?.message).toMatchObject({
      author: 'agent',
      body: 'I can pass your details to the team so they can get back to you.',
      card: { kind: 'consent', prefill: { phone: '+6591234567' } },
    });
    expect(first?.outcome).toBe('answered');
    expect(await decisionCard(first!.message.id)).toBe('consent');

    const { consentId } = await c.answer(true);
    const second = await c.say('My email is Mei@Example.com and my number is 1234 5678');
    expect(second?.message.card).toEqual({
      kind: 'lead_form',
      consentId,
      prefill: { email: 'mei@example.com' },
    });
    expect(second?.message.body).toBe('Please fill in your details below.');
    // The turn wrote no lead and no contact.
    const n = await owner.query(
      `select (select count(*)::int from leads) + (select count(*)::int from contacts) n`,
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('no saved purpose statement: no card at all (fail closed)', async () => {
    const c = await chat();
    const r = await c.say('My number is 9123 4567, please call me back');
    expect(r?.message.card).toBeNull();
    const oos = await c.say('write me a poem');
    expect(oos?.outcome).toBe('out_of_scope');
    expect(oos?.message.card).toBeNull();
  });
});

describe('the consent offer (AC-8)', () => {
  it('goes once per conversation on a reply the AI could not help with', async () => {
    await savePurpose();
    const c = await chat();
    const answered = await c.say('How much is the chocolate cake?');
    expect(answered?.message.card).toBeNull();
    const oos = await c.say('write me a poem');
    expect(oos?.outcome).toBe('out_of_scope');
    expect(oos?.message.card).toEqual({ kind: 'consent', prefill: {} });
    const again = await c.say('tell me about politics');
    expect(again?.outcome).toBe('out_of_scope');
    expect(again?.message.card).toBeNull();
  });

  it('never after a decline, but the visitor can still ask', async () => {
    await savePurpose();
    const c = await chat();
    await c.answer(false);
    const oos = await c.say('write me a poem');
    expect(oos?.outcome).toBe('out_of_scope');
    expect(oos?.message.card).toBeNull();
    const asked = await c.say('Actually, can you call me back? My number is 8123 4567');
    expect(asked?.message.card).toEqual({ kind: 'consent', prefill: { phone: '+6581234567' } });
  });

  it('never on a safety turn', async () => {
    await savePurpose();
    const c = await chat();
    const r = await c.say('I want to die');
    expect(r?.outcome).toBe('ended');
    expect(r?.message.card).toBeNull();
  });
});
