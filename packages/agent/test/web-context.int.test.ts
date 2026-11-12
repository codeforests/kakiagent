/**
 * Web context in a visitor turn (AGT-05; FEAT-029 §5.5, §5.6; AC-4–AC-7).
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeAgentScript, runVisitorTurn } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const NOW = new Date('2026-11-12T03:00:00Z');

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
afterEach(() =>
  owner.query(
    `update widget_settings set tracking_enabled = true, tracking_consent_mode = false where tenant_id = $1`,
    [TENANT_A],
  ),
);
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const requests: GenerateRequest[] = [];
const llm = createGateway(defaultRegistry('fake'), [
  createFakeProvider((req) => {
    requests.push(req);
    return fakeAgentScript(req);
  }),
]);
const visitor = () => tdb.zone('visitor');
const withTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(visitor(), TENANT_A, fn);

async function visitorWithHistory() {
  const visitorId = randomUUID();
  // An earlier conversation three days ago makes the visitor returning.
  await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id, created_at) values ($1, 'widget', $2, now() - interval '3 days')`,
    [TENANT_A, visitorId],
  );
  for (const [path, mins] of [
    ['/kueh-lapis', 30],
    ['/cakes/chocolate-fudge', 5],
  ] as const)
    await owner.query(
      `insert into visitor_events (tenant_id, id, visitor_id, session_id, path, referrer, utm, dwell_ms, consented, viewed_at)
       values ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, 'instagram.com', '{"source":"ig"}', 20000, false, $4::timestamptz - make_interval(mins => $5))`,
      [TENANT_A, visitorId, path, NOW.toISOString(), mins],
    );
  const conv = await withTx((tx) => createConversation(tx, TENANT_A, visitorId));
  return { id: conv.id, visitorId };
}

async function say(conv: { id: string; visitorId: string }, text: string, page: string) {
  const { message } = await withTx((tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId: conv.visitorId,
      text,
      clientMessageId: randomUUID(),
      page,
    }),
  );
  // The message's time is the context's anchor (§5.5): pin it to the test clock.
  await owner.query(`update messages set created_at = $2 where id = $1`, [message.id, NOW]);
  const from = requests.length;
  const result = await runVisitorTurn(
    { zdb: visitor(), llm, clock: () => NOW },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
  const sent = requests.slice(from);
  return {
    result,
    reply: sent.filter((r) => r.model !== 'triage'),
    triage: sent.find((r) => r.model === 'triage')!,
  };
}
const decision = async (conversationId: string) =>
  (
    await owner.query<{ payload: Record<string, unknown> }>(
      `select e.payload from audit_entries e
       where e.tenant_id = $1 and e.event_type = 'agent.decision'
         and $2 = any(e.subject_refs) order by e.seq desc limit 1`,
      [TENANT_A, `conversation:${conversationId}`],
    )
  ).rows[0]?.payload;

describe('web context in a visitor turn (FEAT-029)', () => {
  it('AC-5, AC-7: full context in the reply tail, the current page in triage, recorded in the decision', async () => {
    const conv = await visitorWithHistory();
    const { reply, triage } = await say(conv, 'how much is this cake?', '/cakes/chocolate-fudge');
    expect(reply[0]!.tail).toContain(
      '<page>\ncurrent: /cakes/chocolate-fudge\nviewed: /cakes/chocolate-fudge, /kueh-lapis\nreturning: yes\n</page>',
    );
    expect(reply[0]!.tail).not.toMatch(/instagram|\big\b|20000/);
    expect(triage.tail).toContain('Visitor is on page: /cakes/chocolate-fudge');
    expect(triage.tail).not.toContain('kueh');
    expect(await decision(conv.id)).toMatchObject({
      webScope: 'full',
      webPage: { masked: '/cakes/chocolate-fudge' },
      webViewed: 2,
      webReturning: true,
    });
  });

  it('AC-4: an off tenant gives page_only (current page only)', async () => {
    await owner.query(`update widget_settings set tracking_enabled = false where tenant_id = $1`, [
      TENANT_A,
    ]);
    const conv = await visitorWithHistory();
    const { reply } = await say(conv, 'how much is this cake?', '/cakes/chocolate-fudge');
    expect(reply[0]!.tail).toContain('<page>\ncurrent: /cakes/chocolate-fudge\n</page>');
    expect(reply[0]!.tail).not.toContain('viewed:');
    expect(await decision(conv.id)).toMatchObject({
      webScope: 'page_only',
      webViewed: 0,
      webReturning: false,
    });
  });

  it('AC-6: a fake reply naming a viewed page is blocked and regenerated', async () => {
    const conv = await visitorWithHistory();
    const { reply } = await say(conv, 'what did I look at?', '/cakes/chocolate-fudge');
    expect(reply).toHaveLength(2);
    expect(reply[1]!.tail).toMatch(/blocked .*tracking "/);
    const { rows } = await owner.query<{ body: string }>(
      `select body from messages where conversation_id = $1 and author = 'agent' order by seq desc limit 1`,
      [conv.id],
    );
    expect(rows[0]!.body).toContain("I'm happy to help with anything on this page.");
    expect(rows[0]!.body).not.toMatch(/kueh/i);
    expect((await decision(conv.id))!.violations).toBeGreaterThanOrEqual(1);
  });
});
