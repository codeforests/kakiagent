/**
 * Suggested replies over HTTP (INB-03, KB-18; FEAT-045 §3, §5.3, §5.4; AC-1, AC-3–AC-7):
 * the suggestion route, sending with `suggestionId`, and the staff-edit correction item.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { createFact, dashboardKb, prepareChunk } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import { signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';
const QUESTION = 'How much is the chocolate fudge cake?';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
const cookies = { owner: '', mei: '', other: '' };
let fudge: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET } });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const u = await owner.query(
    `insert into users (email, display_name) values ('mei@kaki-bakery.test', 'Mei Ling') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0].id,
  ]);
  cookies.owner = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookies.mei = await sessionCookie(tdb, 'mei@kaki-bakery.test');
  cookies.other = await sessionCookie(tdb, 'owner@second-tenant.test');
  const input = {
    type: 'product' as const,
    value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
    gstTreatment: 'inclusive' as const,
  };
  const chunk = await prepareChunk(gatewayFromConfig({ provider: 'fake' }), TENANT_A, input);
  fudge = (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, u.rows[0].id), input, chunk),
    )
  ).id;
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});
afterEach(async () => {
  await owner.query(`update tenants set ai_paused = false, ai_paused_at = null`);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

type Who = keyof typeof cookies;
const post = (url: string, who: Who, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookies[who] },
    payload: payload as object,
  });
const get = (url: string, who: Who = 'owner') =>
  app.inject({ method: 'GET', url, headers: { cookie: cookies[who] } });
const suggest = (id: string, who: Who = 'owner') =>
  post(`/api/v1/conversations/${id}/suggestion`, who);
const send = (
  id: string,
  body: string,
  suggestionId?: string,
  clientMessageId = `s-${randomUUID()}`,
) =>
  post(`/api/v1/conversations/${id}/messages`, 'owner', {
    body,
    clientMessageId,
    ...(suggestionId ? { suggestionId } : {}),
  });

/** A widget chat with the question, taken over by the owner unless `take` is false. */
async function chat(text: string | null = QUESTION, take = true) {
  const h = {
    origin: ORIGIN,
    authorization: `Bearer ${signToken(
      { t: TENANT_A, o: ORIGIN, v: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 },
      VISITOR_SECRET,
    )}`,
  };
  const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
  const { conversationId } = conv.json<{ conversationId: string }>();
  if (text)
    await app.inject({
      method: 'POST',
      url: `/widget/v1/conversations/${conversationId}/messages`,
      headers: h,
      payload: { text, clientMessageId: `c-${randomUUID()}` },
    });
  if (take) {
    const res = await post(`/api/v1/conversations/${conversationId}/takeover`, 'owner', {
      version: (
        await owner.query(`select version from conversations where id = $1`, [conversationId])
      ).rows[0].version,
    });
    expect(res.statusCode).toBe(200);
  }
  return conversationId;
}

const replyEdits = async (conversationId: string) =>
  (
    await owner.query(
      `select id, status, source_type, fact_refs from corrections where conversation_ref = $1 and proposed_change->>'kind' = 'reply_edit'`,
      [conversationId],
    )
  ).rows;

describe('POST /suggestion (AC-1, AC-5, AC-6, AC-7)', () => {
  it('201 with a checked draft and its fact chips; nothing sent', async () => {
    const id = await chat();
    const res = await suggest(id);
    expect(res.statusCode).toBe(201);
    const { suggestion, none } = res.json();
    expect(none).toBeNull();
    expect(suggestion.text).toContain('S$55.00');
    expect(suggestion.facts).toEqual([
      expect.objectContaining({ id: fudge, label: expect.stringContaining('Chocolate fudge') }),
    ]);
    expect(suggestion).toMatchObject({ language: 'en', forSeq: expect.any(Number) });
    const staff = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1 and author in ('agent', 'staff')`,
      [id],
    );
    expect(staff.rows[0].n).toBe(0);
  });

  it('409 not_owner, ai_paused, nothing_to_answer', async () => {
    const id = await chat();
    const notOwner = await suggest(id, 'mei');
    expect(notOwner.statusCode).toBe(409);
    expect(notOwner.json()).toMatchObject({ error: 'not_owner', conversation: { id } });
    const untaken = await suggest(await chat(QUESTION, false));
    expect(untaken.json().error).toBe('not_owner');

    await owner.query(`update tenants set ai_paused = true, ai_paused_at = now() where id = $1`, [
      TENANT_A,
    ]);
    const paused = await suggest(id);
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toEqual({
      error: 'ai_paused',
      message: "The assistant is paused, so it can't suggest replies.",
    });
    await owner.query(`update tenants set ai_paused = false, ai_paused_at = null`);

    const empty = await suggest(await chat(null));
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe('nothing_to_answer');
  });

  it('429 with Retry-After after 10 in an hour', async () => {
    const id = await chat();
    for (let i = 0; i < 10; i++) expect((await suggest(id)).statusCode).toBe(201);
    const res = await suggest(id);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('too_many_suggestions');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3000);
  });

  it('404 for another tenant on both routes; 422 for a body', async () => {
    const id = await chat();
    expect((await suggest(id, 'other')).statusCode).toBe(404);
    const theirs = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${id}/messages`,
      headers: { cookie: cookies.other },
      payload: { body: 'Hi', clientMessageId: `s-${randomUUID()}` },
    });
    expect(theirs.statusCode).toBe(404);
    expect((await suggest(randomUUID())).statusCode).toBe(404);
    expect(
      (await post(`/api/v1/conversations/${id}/suggestion`, 'owner', { text: 'x' })).statusCode,
    ).toBe(422);
  });
});

describe('sending a draft (AC-3, AC-4)', () => {
  it('unedited: the message carries the draft facts, no correction', async () => {
    const id = await chat();
    const { suggestion } = (await suggest(id)).json();
    const res = await send(id, `${suggestion.text}  `, suggestion.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().message.factIds).toEqual([fudge]);
    expect(await replyEdits(id)).toEqual([]);
  });

  it('edited: one open staff_edit item with question, draft and sent; a retry adds none; accepted as an FAQ', async () => {
    const id = await chat();
    const { suggestion } = (await suggest(id)).json();
    const key = `s-${randomUUID()}`;
    const sent = 'The chocolate fudge cake is S$55.00, and we deliver islandwide.';
    const res = await send(id, sent, suggestion.id, key);
    expect(res.statusCode).toBe(201);
    expect(res.json().message.factIds).toEqual([]);
    expect((await send(id, sent, suggestion.id, key)).statusCode).toBe(200);
    const items = await replyEdits(id);
    expect(items).toEqual([
      { id: expect.any(String), status: 'open', source_type: 'staff_edit', fact_refs: [fudge] },
    ]);

    const list = (await get('/api/v1/corrections?status=open')).json();
    const row = list.corrections.find((c: { id: string }) => c.id === items[0].id);
    expect(row).toMatchObject({
      source: 'staff_edit',
      proposedBy: 'staff',
      change: { kind: 'reply_edit', suggestionId: suggestion.id },
      replyEdit: { question: QUESTION },
    });

    const detail = await get(`/api/v1/corrections/${items[0].id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().context.replyEdit).toMatchObject({
      question: QUESTION,
      suggested: suggestion.text,
      sent,
      facts: [expect.objectContaining({ id: fudge })],
    });

    const bare = await post(`/api/v1/corrections/${items[0].id}/accept`, 'owner', {});
    expect(bare.statusCode).toBe(422);
    const accepted = await post(`/api/v1/corrections/${items[0].id}/accept`, 'owner', {
      edit: { kind: 'add_faq', question: QUESTION, answer: sent },
    });
    expect(accepted.statusCode).toBe(200);
    const faq = await owner.query(
      `select status from facts where tenant_id = $1 and type = 'faq' and value->>'answer' = $2`,
      [TENANT_A, sent],
    );
    expect(faq.rows).toEqual([{ status: 'approved' }]);
  });

  it('a bogus or another conversation’s suggestionId still sends, with no correction', async () => {
    const id = await chat();
    expect((await send(id, 'Hello there', randomUUID())).statusCode).toBe(201);
    const other = await chat();
    const { suggestion } = (await suggest(other)).json();
    expect((await send(id, 'Changed text', suggestion.id)).statusCode).toBe(201);
    expect(await replyEdits(id)).toEqual([]);
    expect(await replyEdits(other)).toEqual([]);
  });
});
