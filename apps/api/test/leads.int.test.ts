/**
 * FEAT-049 dashboard side (§3, §5.4, §5.5; AC-10, AC-12): Leads and consent settings (Owner and
 * Admin, stale check, field errors, tenant isolation), the inbox sidebar's contact and lead,
 * the consent and capture dividers, and search by a contact's phone.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import { captureLead, leadCaptureConfig, recordConsent } from '@kaki/leads';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asAgent: string;
let asB: string;

const FIELDS = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'required' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'optional' },
  { key: 'preferredTime', mode: 'off' },
];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const u = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const get = (who: string) =>
  app.inject({ method: 'GET', url: '/api/v1/settings/leads', headers: { cookie: who } });
const put = (who: string, body: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1/settings/leads',
    headers: { cookie: who },
    payload: body as Record<string, unknown>,
  });

describe('Leads and consent settings (SCR-APP-043; D3, D6)', () => {
  it('reads defaults, saves, refuses stale versions and bad bodies, and is Owner/Admin only', async () => {
    const first = await get(asA);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      version: 0,
      marketing: { enabled: false, wording: null },
      purpose: { saved: false },
    });
    expect((await get(asAgent)).statusCode).toBe(403);
    const body = {
      version: 0,
      fields: FIELDS,
      marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
    };
    const saved = await put(asA, body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      version: 1,
      fields: FIELDS,
      marketing: { enabled: true, text: { en: 'Send me offers' }, wording: { seq: 1 } },
    });
    const stale = await put(asA, body);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale', current: { version: 1 } });
    const noContact = await put(asA, {
      ...body,
      version: 1,
      fields: FIELDS.map((f) =>
        f.key === 'phone' || f.key === 'email' ? { ...f, mode: 'off' } : f,
      ),
    });
    expect(noContact.statusCode).toBe(400);
    expect(noContact.json()).toMatchObject({ code: 'phone_or_email' });
    const emptyText = await put(asA, {
      ...body,
      version: 1,
      marketing: { enabled: true, text: { en: ' ', zh: null } },
    });
    expect(emptyText.statusCode).toBe(400);
    expect(emptyText.json()).toMatchObject({ code: 'marketing_text' });
    expect((await put(asAgent, { ...body, version: 1 })).statusCode).toBe(403);
    // Tenant B sees its own defaults, never A's save.
    expect((await get(asB)).json()).toMatchObject({ version: 0, marketing: { enabled: false } });
    const audits = await owner.query(
      `select payload::text as p from audit_entries where tenant_id = $1 and event_type = 'settings.lead_fields_updated'`,
      [TENANT_A],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].p).not.toContain('Send me offers');
  });
});

describe('the inbox sidebar, dividers and search (AC-10, AC-12)', () => {
  it('shows the contact, lead and consent, the dividers, and finds the chat by phone', async () => {
    const ownerId = (
      await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)
    ).rows[0].id;
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      savePurposeStatement(tx, {
        tenantId: TENANT_A,
        userId: ownerId,
        version: 0,
        purpose: { en: 'To reply to you.', zh: null },
      }),
    );
    const conv = (
      await owner.query<{ id: string }>(
        `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
        [TENANT_A],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'visitor', 'Can someone call me?')`,
      [TENANT_A, conv],
    );
    await withTenant(tdb.zone('visitor'), TENANT_A, async (tx) => {
      const config = (await leadCaptureConfig(tx))!;
      const { consentId } = await recordConsent(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        purposeWordingId: config.purpose.wordingId,
        agreed: true,
        marketing: { wordingId: config.marketing!.wordingId, agreed: true },
      });
      await captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        consentId: consentId!,
        input: {
          name: 'Mei Ling',
          phone: '9876 1234',
          email: '',
          need: '',
          budget: '',
          preferredTime: '',
        },
      });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv}`,
      headers: { cookie: asAgent },
    });
    expect(res.statusCode).toBe(200);
    const thread = res.json();
    expect(thread.sidebar.contact).toMatchObject({
      name: 'Mei Ling',
      phone: '+65 9876 1234',
      email: null,
      label: 'Mei Ling',
    });
    expect(thread.sidebar.lead).toMatchObject({
      status: 'new',
      consent: { marketing: { agreed: true } },
      // FEAT-050: scored at capture (phone only, nothing else said: cold).
      scoring: { score: 'cold', points: 0, reasons: [] },
    });
    expect(
      thread.events
        .filter((e: { kind: string }) => e.kind === 'consent' || e.kind === 'lead')
        .map((e: { kind: string; reason: string }) => [e.kind, e.reason]),
    ).toEqual([
      ['consent', 'agreed'],
      ['lead', 'created'],
    ]);
    const notice = thread.messages.find(
      (m: { noticeKind: string }) => m.noticeKind === 'lead_captured',
    );
    expect(notice).toMatchObject({ author: 'system', card: null });

    const found = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/search',
      headers: { cookie: asAgent },
      payload: { q: '98761234' },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().results).toEqual([
      expect.objectContaining({
        conversation: expect.objectContaining({ id: conv }),
        match: expect.objectContaining({ source: 'contact', field: 'phone' }),
      }),
    ]);
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/search',
      headers: { cookie: asB },
      payload: { q: '98761234' },
    });
    expect(other.json().results).toEqual([]);
  });
});
