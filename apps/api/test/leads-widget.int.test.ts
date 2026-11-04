/**
 * FEAT-049 §3, §5.4 (AC-1–AC-6, AC-9): the widget's consent, lead and contact-form routes, and
 * `leadCapture` in the widget config. Tenant and visitor come from the token; another
 * visitor's or tenant's conversation is a 404; nothing is stored without consent.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import { signToken } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let ownerId: string;
const published: {
  channel: string;
  payload: { type: string; message?: { noticeKind?: string } };
}[] = [];

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
});
afterEach(async () => {
  await owner.query(`delete from messages where notice_kind = 'lead_captured'`);
  await owner.query(`delete from leads`);
  await owner.query(`delete from consents`);
  await owner.query(`update conversations set contact_id = null`);
  await owner.query(`delete from contacts`);
  await owner.query(`delete from privacy_settings`);
  await owner.query(`update tenants set ai_paused = false, ai_paused_at = null`);
  await owner.query(`update channel_connections set state = 'live'`);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const headers = (tenant = TENANT_A, visitorId = randomUUID()) => ({
  origin: ORIGIN,
  authorization: `Bearer ${signToken(
    { t: tenant, o: ORIGIN, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});
const savePurpose = () =>
  withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: ownerId,
      version: 0,
      purpose: { en: 'To reply to you.', zh: '为了回复您。' },
    }),
  );
const config = async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/widget/v1/config?key=wk_dev_bakery',
    headers: { origin: ORIGIN },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ leadCapture: { purpose: { wordingId: string } } | null }>().leadCapture;
};
const startChat = async (h: Record<string, string>) =>
  (await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h })).json<{
    conversationId: string;
  }>().conversationId;
const post = (url: string, h: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: h, payload: payload as Record<string, unknown> });

describe('widget config leadCapture (LED-02)', () => {
  it('is null until a purpose statement is saved, then carries the wording and fields', async () => {
    expect(await config()).toBeNull();
    await savePurpose();
    expect(await config()).toMatchObject({
      purpose: { text: { en: 'To reply to you.', zh: '为了回复您。' } },
      prompt: { en: 'Is it OK for us to use your details for this?' },
      marketing: null,
      fields: expect.arrayContaining([{ key: 'name', mode: 'required' }]),
    });
  });
});

describe('consent and lead (AC-1–AC-6)', () => {
  it('agree → submit creates the lead and publishes the notice; a stale wording is 409', async () => {
    await savePurpose();
    const h = headers();
    const id = await startChat(h);
    const lc = (await config())!;
    const stale = await post(`/widget/v1/conversations/${id}/consent`, h, {
      purposeWordingId: randomUUID(),
      agreed: true,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'wording_changed',
      leadCapture: { purpose: { wordingId: lc.purpose.wordingId } },
    });
    const noConsent = await post(`/widget/v1/conversations/${id}/lead`, h, {
      consentId: randomUUID(),
      fields: { name: 'Mei', phone: '91234567' },
    });
    expect(noConsent.statusCode).toBe(409);
    expect(noConsent.json()).toMatchObject({ error: 'consent_required' });

    const consent = await post(`/widget/v1/conversations/${id}/consent`, h, {
      purposeWordingId: lc.purpose.wordingId,
      agreed: true,
    });
    expect(consent.statusCode).toBe(201);
    const { consentId } = consent.json<{ consentId: string }>();
    const bad = await post(`/widget/v1/conversations/${id}/lead`, h, {
      consentId,
      fields: { name: '', phone: '123' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({
      error: 'invalid_fields',
      fields: { name: 'required', phone: 'invalid' },
      needsContact: false,
    });
    published.length = 0;
    const ok = await post(`/widget/v1/conversations/${id}/lead`, h, {
      consentId,
      fields: { name: 'Mei', phone: '9123 4567' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      status: 'created',
      notice: { author: 'system', noticeKind: 'lead_captured' },
    });
    expect(published.map((p) => p.payload.type)).toEqual(['message', 'message', 'conversation']);
    const again = await post(`/widget/v1/conversations/${id}/lead`, h, {
      consentId,
      fields: { name: 'Mei Ling', phone: '+65 9123 4567', need: 'Cake' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'updated' });
  });

  it("another visitor's or tenant's conversation is a 404, and a decline stores no contact", async () => {
    await savePurpose();
    const lc = (await config())!;
    const id = await startChat(headers());
    for (const h of [headers(), headers(TENANT_B)]) {
      const res = await post(`/widget/v1/conversations/${id}/consent`, h, {
        purposeWordingId: lc.purpose.wordingId,
        agreed: true,
      });
      expect(res.statusCode).toBe(404);
    }
    const h = headers();
    const own = await startChat(h);
    const declined = await post(`/widget/v1/conversations/${own}/consent`, h, {
      purposeWordingId: lc.purpose.wordingId,
      agreed: false,
    });
    expect(declined.json()).toEqual({ consentId: null });
    const rows = await owner.query(`select decision, contact_id from consents`);
    expect(rows.rows).toEqual([{ decision: 'declined', contact_id: null }]);
    // Strict bodies: a tenant ID in the body is refused.
    const strict = await post(`/widget/v1/conversations/${own}/consent`, h, {
      purposeWordingId: lc.purpose.wordingId,
      agreed: true,
      tenantId: TENANT_B,
    });
    expect(strict.statusCode).toBe(400);
  });
});

describe('the fallback contact form (AC-9; GOV-08)', () => {
  it('works while paused or not live, and is refused while the chat is open', async () => {
    await savePurpose();
    const lc = (await config())!;
    const h = headers();
    const body = {
      purposeWordingId: lc.purpose.wordingId,
      agreed: true,
      fields: { name: 'Ah Kow', email: 'ah@kow.sg' },
    };
    const open = await post('/widget/v1/contact', h, body);
    expect(open.statusCode).toBe(409);
    expect(open.json()).toMatchObject({ error: 'not_capturing' });
    await owner.query(`update channel_connections set state = 'offline' where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(await config()).not.toBeNull();
    const preLive = await post('/widget/v1/contact', h, body);
    expect(preLive.statusCode).toBe(201);
    expect(preLive.json()).toEqual({ status: 'created' });
    await owner.query(`update channel_connections set state = 'live'`);
    await owner.query(`update tenants set ai_paused = true, ai_paused_at = now() where id = $1`, [
      TENANT_A,
    ]);
    const id = await startChat(h);
    const paused = await post('/widget/v1/contact', h, { ...body, conversationId: id });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ status: 'updated' });
    const leads = await owner.query(`select captures, conversation_id from leads`);
    expect(leads.rows).toEqual([{ captures: 2, conversation_id: id }]);
  });

  it('without a saved purpose statement it is refused', async () => {
    await owner.query(`update tenants set ai_paused = true, ai_paused_at = now() where id = $1`, [
      TENANT_A,
    ]);
    const res = await post('/widget/v1/contact', headers(), {
      purposeWordingId: randomUUID(),
      agreed: true,
      fields: { name: 'Ah Kow', email: 'ah@kow.sg' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_capturing' });
  });
});
