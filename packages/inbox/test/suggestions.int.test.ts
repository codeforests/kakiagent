/**
 * Suggested replies on the real schema (INB-03, KB-18; FEAT-045 §5.2, AC-3, AC-4, D7, D8):
 * storing and superseding drafts, the rate limit, and recording a draft's use on send.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendVisitorMessage,
  createConversation,
  getSuggestion,
  latestVisitorMessage,
  recordSuggestionUse,
  sendStaffMessage,
  storeSuggestion,
  suggestionQuestions,
  suggestionRetryAfter,
  SUGGESTIONS_PER_HOUR,
  takeOver,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const MEI = '00000000-0000-4000-8000-0000000000a1';
const FACT = '00000000-0000-4000-8000-00000000f001';
const DRAFT = 'Our chocolate cake is $48.';

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

/** A conversation Mei has taken over, with one visitor question. */
async function handled() {
  const visitorId = randomUUID();
  const conv = await withTenant(visitor(), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  const { message } = await withTenant(visitor(), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text: 'How much is the chocolate cake?',
      clientMessageId: randomUUID(),
    }),
  );
  const v = (await owner.query(`select version from conversations where id = $1`, [conv.id]))
    .rows[0].version;
  await withTenant(dash(), TENANT_A, (tx) =>
    takeOver(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      userId: MEI,
      visitorName: 'Mei Ling',
      version: v,
    }),
  );
  return { id: conv.id, question: message };
}

const store = (
  c: { id: string; question: { id: string } },
  extra: Partial<Parameters<typeof storeSuggestion>[1]> = {},
) =>
  withTenant(dash(), TENANT_A, (tx) =>
    storeSuggestion(tx, {
      tenantId: TENANT_A,
      id: randomUUID(),
      conversationId: c.id,
      forMessageId: c.question.id,
      requestedBy: MEI,
      outcome: 'ready',
      body: DRAFT,
      factIds: [FACT],
      language: 'en',
      ...extra,
    }),
  );

/** Sends `body` as Mei, recording the suggestion's use as the messages route does. */
const send = (
  conversationId: string,
  body: string,
  suggestionId: string,
  clientMessageId = randomUUID(),
) =>
  withTenant(dash(), TENANT_A, async (tx) => {
    const sent = await sendStaffMessage(tx, {
      tenantId: TENANT_A,
      conversationId,
      userId: MEI,
      body,
      clientMessageId,
    });
    const use = sent.created
      ? await recordSuggestionUse(tx, {
          tenantId: TENANT_A,
          conversationId,
          userId: MEI,
          suggestionId,
          message: sent.message,
        })
      : null;
    return { sent, use };
  });

const row = (id: string) =>
  owner
    .query(`select status, sent_message_id, used_at from suggestions where id = $1`, [id])
    .then((r) => r.rows[0]);
const factIdsOf = (messageId: string) =>
  owner
    .query(`select fact_ids from messages where id = $1`, [messageId])
    .then((r) => r.rows[0].fact_ids);

describe('storing suggestions', () => {
  it('the latest visitor message is what a draft answers; a new draft supersedes the open one', async () => {
    const c = await handled();
    const latest = await withTenant(dash(), TENANT_A, (tx) =>
      latestVisitorMessage(tx, TENANT_A, c.id),
    );
    expect(latest?.id).toBe(c.question.id);
    const first = await store(c);
    const second = await store(c, { outcome: 'no_checked_answer', body: null, factIds: [FACT] });
    expect((await row(first.id)).status).toBe('superseded');
    expect(second).toMatchObject({ status: 'open', body: null, factIds: [] });
  });

  it('masks the draft (ADR-015)', async () => {
    const c = await handled();
    const s = await store(c, { body: 'Call 9123 4567, NRIC S1234567D.' });
    expect(s.body).not.toContain('S1234567D');
  });

  it(`allows ${SUGGESTIONS_PER_HOUR} an hour, then gives the seconds until the oldest expires (D5)`, async () => {
    const c = await handled();
    const now = new Date();
    for (let i = 0; i < SUGGESTIONS_PER_HOUR; i++) await store(c);
    await owner.query(
      `update suggestions set created_at = now() - interval '50 minutes'
        where id = (select id from suggestions where conversation_id = $1 order by created_at limit 1)`,
      [c.id],
    );
    const wait = await withTenant(dash(), TENANT_A, (tx) =>
      suggestionRetryAfter(tx, TENANT_A, c.id, now),
    );
    expect(wait).toBeGreaterThan(9 * 60);
    expect(wait).toBeLessThanOrEqual(10 * 60 + 1);
    const other = await handled();
    expect(
      await withTenant(dash(), TENANT_A, (tx) => suggestionRetryAfter(tx, TENANT_A, other.id, now)),
    ).toBe(0);
  });
});

describe('recording a draft on send (AC-3, AC-4, D7, D8)', () => {
  it('unedited (case, spacing, trailing punctuation only): sent, the draft facts on the message, audited', async () => {
    const c = await handled();
    const s = await store(c);
    const { sent, use } = await send(c.id, 'our chocolate cake is  $48 🙂', s.id);
    expect(use).toEqual({ used: true, edited: false, factIds: [FACT] });
    expect(await row(s.id)).toMatchObject({ status: 'sent', sent_message_id: sent.message.id });
    expect(await factIdsOf(sent.message.id)).toEqual([FACT]);
    const audit = await owner.query(
      `select payload, actor_ref, subject_refs from audit_entries where event_type = 'inbox.suggestion.sent' and $1 = any(subject_refs)`,
      [`suggestion:${s.id}`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload).toEqual({ suggestionId: s.id, edited: false });
    expect(audit.rows[0].actor_ref).toBe(MEI);
    expect(JSON.stringify(audit.rows[0])).not.toContain('chocolate');
  });

  it('edited: sent_edited, no facts on the message', async () => {
    const c = await handled();
    const s = await store(c);
    const { sent, use } = await send(c.id, 'Our chocolate cake is $52.', s.id);
    expect(use).toEqual({ used: true, edited: true, factIds: [FACT] });
    expect((await row(s.id)).status).toBe('sent_edited');
    expect(await factIdsOf(sent.message.id)).toEqual([]);
  });

  it('a used, superseded, unchecked or other-conversation suggestion is ignored; the message is still sent', async () => {
    const c = await handled();
    const used = await store(c);
    await send(c.id, DRAFT, used.id);
    const again = await send(c.id, 'Something else', used.id);
    expect(again.use).toEqual({ used: false });
    expect(again.sent.created).toBe(true);

    const old = await store(c);
    await store(c);
    expect((await send(c.id, 'x', old.id)).use).toEqual({ used: false });

    const none = await store(c, { outcome: 'no_checked_answer', body: null });
    expect((await send(c.id, 'x', none.id)).use).toEqual({ used: false });

    const elsewhere = await handled();
    const foreign = await store(elsewhere);
    expect((await send(c.id, 'x', foreign.id)).use).toEqual({ used: false });
    expect((await row(foreign.id)).status).toBe('open');

    expect((await send(c.id, 'x', randomUUID())).use).toEqual({ used: false });
  });

  it('a retried send records nothing again', async () => {
    const c = await handled();
    const s = await store(c);
    const key = randomUUID();
    const first = await send(c.id, 'Changed', s.id, key);
    const retry = await send(c.id, 'Changed', s.id, key);
    expect(first.use).toMatchObject({ used: true, edited: true });
    expect(retry.sent.created).toBe(false);
    expect(retry.use).toBeNull();
  });

  it('reads a suggestion and the questions behind several', async () => {
    const c = await handled();
    const s = await store(c);
    const got = await withTenant(dash(), TENANT_A, (tx) => getSuggestion(tx, TENANT_A, s.id));
    expect(got?.body).toBe(DRAFT);
    const qs = await withTenant(dash(), TENANT_A, (tx) =>
      suggestionQuestions(tx, TENANT_A, [s.id, randomUUID()]),
    );
    expect([...qs]).toEqual([[s.id, 'How much is the chocolate cake?']]);
  });
});
