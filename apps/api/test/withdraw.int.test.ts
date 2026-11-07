/**
 * FEAT-051 routes (§3, §5.4; AC-3, AC-4, AC-6, AC-7): the widget's withdraw button and the Lead
 * page's "Record withdrawal". The contact comes from the conversation or the lead, never the
 * body; a repeat writes nothing; tenant B and other conversations get 404; exports leave the
 * withdrawn lead out and audit how many.
 */
import { LeadDetail, WithdrawResponse } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import { captureLead, leadCaptureConfig, recordConsent, saveLeadSettings } from '@kaki/leads';
import { signToken } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let ownerId: string;
let asA: string;
let asAgent: string;
let asB: string;
const published: { channel: string; payload: { type: string } }[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET },
    publisher: {
      publish: async (channel: string, payload: unknown) =>
        void published.push({ channel, payload: payload as { type: string } }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  await owner.query(`update users set display_name = 'Ken Tan' where id = $1`, [ownerId]);
  const u = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff.withdraw@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff.withdraw@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: ownerId,
      version: 0,
      purpose: { en: 'To reply to you.', zh: null },
    }),
  );
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    saveLeadSettings(tx, {
      tenantId: TENANT_A,
      userId: ownerId,
      version: 0,
      fields: [
        { key: 'name', mode: 'required' },
        { key: 'phone', mode: 'optional' },
        { key: 'email', mode: 'optional' },
        { key: 'need', mode: 'optional' },
        { key: 'budget', mode: 'optional' },
        { key: 'preferredTime', mode: 'optional' },
      ],
      marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
      qualification: { keywords: [], minBudget: null },
    }),
  );
});
afterEach(async () => {
  await owner.query(`delete from notifications`);
  await owner.query(`delete from messages where card is not null or notice_kind is not null`);
  await owner.query(`delete from leads`);
  await owner.query(`delete from consents`);
  await owner.query(`update conversations set contact_id = null`);
  await owner.query(`delete from contacts`);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const headers = (visitorId = randomUUID()) => ({
  origin: ORIGIN,
  authorization: `Bearer ${signToken(
    { t: TENANT_A, o: ORIGIN, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});
const startChat = async (h: Record<string, string>) =>
  (await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h })).json<{
    conversationId: string;
  }>().conversationId;
const post = (url: string, h: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: h, payload: payload as Record<string, unknown> });
const dash = (url: string, cookie: string, payload?: unknown) =>
  app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

/** A chat whose visitor left their details (offers agreed or not). */
async function capturedChat(offers: boolean, email = 'mei@example.com') {
  const h = headers();
  const id = await startChat(h);
  const vis = tdb.zone('visitor');
  const cfg = (await withTenant(vis, TENANT_A, leadCaptureConfig))!;
  const { consentId } = await withTenant(vis, TENANT_A, (tx) =>
    recordConsent(tx, {
      tenantId: TENANT_A,
      conversationId: id,
      purposeWordingId: cfg.purpose.wordingId,
      agreed: true,
      marketing: { wordingId: cfg.marketing!.wordingId, agreed: offers },
    }),
  );
  const captured = await withTenant(vis, TENANT_A, (tx) =>
    captureLead(tx, {
      tenantId: TENANT_A,
      conversationId: id,
      consentId: consentId!,
      input: { name: 'Mei', email, phone: '', need: '', budget: '', preferredTime: '' },
    }),
  );
  return { h, id, leadId: captured.leadId };
}
/** The agent's message carrying the withdraw card, as the turn stores it. */
const withdrawCard = async (conversationId: string, offers: boolean) =>
  (
    await owner.query<{ id: string }>(
      `insert into messages (tenant_id, conversation_id, author, body, card)
       values ($1, $2, 'agent', 'Sure. Choose below.', $3) returning id`,
      [TENANT_A, conversationId, { kind: 'withdraw', offers }],
    )
  ).rows[0]!.id;

describe('POST /widget/v1/conversations/:id/withdraw (AC-3, AC-4)', () => {
  it('withdraws with the notice and publishes it; a repeat is already_withdrawn with no notice', async () => {
    const c = await capturedChat(true);
    const messageId = await withdrawCard(c.id, true);
    published.length = 0;
    const res = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId,
      scope: 'all',
    });
    expect(res.statusCode).toBe(201);
    const body = WithdrawResponse.parse(res.json());
    expect(body.status).toBe('withdrawn');
    expect(body.notice).toMatchObject({
      author: 'system',
      noticeKind: 'consent_withdrawn',
      notice: expect.stringMatching(/will stop using your contact details and won't contact you/),
    });
    // The notice to the widget's and the inbox's channels, then the inbox row.
    expect(published.map((p) => p.payload.type)).toEqual(['message', 'message', 'conversation']);

    const again = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId,
      scope: 'all',
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ status: 'already_withdrawn', notice: null });
    const notices = await owner.query(
      `select count(*)::int n from messages where conversation_id = $1 and notice_kind = 'consent_withdrawn'`,
      [c.id],
    );
    expect(notices.rows[0].n).toBe(1);

    const lead = LeadDetail.parse((await dash(`/api/v1/leads/${c.leadId}`, asA)).json());
    expect(lead.consentWithdrawnAt).not.toBeNull();
    expect(lead.consents.filter((r) => r.decision === 'withdrawn')).toHaveLength(2);
  });

  it("another conversation's message is 404; marketing on a card without offers is 422", async () => {
    const c = await capturedChat(false);
    const other = await capturedChat(false, 'other@example.com');
    const foreign = await withdrawCard(other.id, false);
    const res = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId: foreign,
      scope: 'all',
    });
    expect(res.statusCode).toBe(404);
    // Another visitor can't press this conversation's card either.
    const own = await withdrawCard(c.id, false);
    expect(
      (
        await post(`/widget/v1/conversations/${c.id}/withdraw`, headers(), {
          messageId: own,
          scope: 'all',
        })
      ).statusCode,
    ).toBe(404);
    const marketing = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId: own,
      scope: 'marketing',
    });
    expect(marketing.statusCode).toBe(422);
    expect(marketing.json()).toMatchObject({ error: 'scope_not_offered' });
    const strict = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId: own,
      scope: 'all',
      contactId: randomUUID(),
    });
    expect(strict.statusCode).toBe(400);
  });

  it('marketing only: offers stopped, the lead still exports', async () => {
    const c = await capturedChat(true, 'offers.only@example.com');
    const messageId = await withdrawCard(c.id, true);
    const res = await post(`/widget/v1/conversations/${c.id}/withdraw`, c.h, {
      messageId,
      scope: 'marketing',
    });
    expect(res.json()).toMatchObject({
      status: 'withdrawn',
      notice: { notice: expect.stringMatching(/won't send you offers/) },
    });
    const lead = LeadDetail.parse((await dash(`/api/v1/leads/${c.leadId}`, asA)).json());
    expect(lead.consentWithdrawnAt).toBeNull();
    expect(lead.marketing).toMatchObject({ agreed: false, withdrawn: true });
    // AC-4 (acceptance correction): the lead still exports, with Marketing consent "No".
    await owner.query(`update sessions set reauth_at = now() where user_id = $1`, [ownerId]);
    const csv = await dash('/api/v1/leads/export', asA, { status: 'all' });
    expect(csv.statusCode).toBe(200);
    const line = csv.body.split('\n').find((l) => l.includes('offers.only@example.com'));
    expect(line).toBeDefined();
    expect(line).toMatch(/,No,/);
    expect(line).not.toMatch(/,Yes,/);
  });

  it('a visitor with no contact: nothing_held, nothing written', async () => {
    const h = headers();
    const id = await startChat(h);
    const messageId = await withdrawCard(id, false);
    const res = await post(`/widget/v1/conversations/${id}/withdraw`, h, {
      messageId,
      scope: 'all',
    });
    expect(res.json()).toEqual({ status: 'nothing_held', notice: null });
    expect((await owner.query(`select count(*)::int n from consents`)).rows[0].n).toBe(0);
  });
});

describe('POST /api/v1/leads/:id/withdraw (AC-6, AC-7)', () => {
  it('an Owner records it with their name; Agent 403; tenant B 404; the export leaves it out', async () => {
    const c = await capturedChat(false);
    const kept = await capturedChat(false, 'kept@example.com');
    expect(
      (await dash(`/api/v1/leads/${c.leadId}/withdraw`, asAgent, { scope: 'all' })).statusCode,
    ).toBe(403);
    expect(
      (await dash(`/api/v1/leads/${c.leadId}/withdraw`, asB, { scope: 'all' })).statusCode,
    ).toBe(404);
    expect(
      (await dash(`/api/v1/leads/${c.leadId}/withdraw`, asA, { scope: 'marketing' })).json(),
    ).toMatchObject({ error: 'scope_not_offered' });

    const res = await dash(`/api/v1/leads/${c.leadId}/withdraw`, asA, { scope: 'all' });
    expect(res.statusCode).toBe(200);
    const d = LeadDetail.parse(res.json());
    expect(d.consentWithdrawnAt).not.toBeNull();
    expect(d.consents[0]).toMatchObject({
      decision: 'withdrawn',
      channel: 'dashboard',
      recordedBy: 'Ken Tan',
      wording: null,
    });
    const again = await dash(`/api/v1/leads/${c.leadId}/withdraw`, asA, { scope: 'all' });
    expect(again.statusCode).toBe(200);
    expect(LeadDetail.parse(again.json()).consents).toHaveLength(d.consents.length);
    // The recorder isn't alerted about their own withdrawal.
    const mine = await owner.query(
      `select count(*)::int n from notifications where kind = 'consent_withdrawn' and user_id = $1`,
      [ownerId],
    );
    expect(mine.rows[0].n).toBe(0);

    await owner.query(`update sessions set reauth_at = now() where user_id = $1`, [ownerId]);
    const csv = await dash('/api/v1/leads/export', asA, { status: 'all' });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('kept@example.com');
    expect(csv.body).not.toContain('mei@example.com');
    const audit = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'lead.exported'
       order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(audit.rows[0].payload).toMatchObject({ count: 1, excluded: 1 });
    // The list still shows the withdrawn lead (D4).
    const list = (await dash('/api/v1/leads?status=all', asA)).json<{ items: { id: string }[] }>();
    expect(list.items.map((i) => i.id)).toEqual(expect.arrayContaining([c.leadId, kept.leadId]));
  });
});
