/**
 * FEAT-039 dashboard side (§3, §5.4; AC-4–AC-7): the Contact page, contact search, the merge
 * preview, merge and undo (any staff role), their 404s, 409s and 401, and the thread sidebar's
 * verified marks and duplicate hint.
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asAgent: string;
let asB: string;
let wording: string;
let keep: string;
let other: string;
let keepConversation: string;
let foreign: string;

const q = <T extends pg.QueryResultRow = { id: string }>(text: string, args: unknown[] = []) =>
  owner.query<T>(text, args);
const call = (who: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function contact(
  t: string,
  v: { name?: string; email?: string; telegram?: number; lead?: boolean; at?: string },
) {
  const id = (
    await q(
      `insert into contacts (tenant_id, name, email, telegram_id, created_at)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now())) returning id`,
      [t, v.name ?? null, v.email ?? null, v.telegram ?? null, v.at ?? null],
    )
  ).rows[0]!.id;
  const conv = (
    await q(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id)
       values ($1, $2, gen_random_uuid(), $3) returning id`,
      [t, v.telegram ? 'telegram' : 'widget', id],
    )
  ).rows[0]!.id;
  if (v.email)
    await q(
      `insert into contact_identities (tenant_id, contact_id, kind, value, source) values ($1, $2, 'email', $3, 'lead_form')`,
      [t, id, v.email],
    );
  if (v.telegram)
    await q(
      `insert into contact_identities (tenant_id, contact_id, kind, value, source, verified_at)
       values ($1, $2, 'telegram', $3, 'telegram', now())`,
      [t, id, String(v.telegram)],
    );
  if (v.lead) {
    const consent = (
      await q(
        `insert into consents (tenant_id, contact_id, conversation_id, purpose, decision, wording_id, channel)
         values ($1, $2, $3, 'enquiry', 'agreed', $4, 'widget') returning id`,
        [t, id, conv, wording],
      )
    ).rows[0]!.id;
    await q(
      `insert into leads (tenant_id, contact_id, consent_id, conversation_id, need) values ($1, $2, $3, $4, 'Cake')`,
      [t, id, consent, conv],
    );
  }
  return { id, conv };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const u = await q(`insert into users (email) values ('staff@kaki-bakery.test') returning id`);
  await q(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    u.rows[0]!.id,
  ]);
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  wording = (
    await q(
      `insert into wording_versions (tenant_id, kind, seq, content)
       values ($1, 'purpose_statement', 1, '{"en":"To reply."}') returning id`,
      [TENANT_A],
    )
  ).rows[0]!.id;
  const k = await contact(TENANT_A, {
    name: 'Siti',
    email: 'siti@kaki.test',
    lead: true,
    at: '2026-11-01T00:00:00Z',
  });
  keep = k.id;
  keepConversation = k.conv;
  other = (await contact(TENANT_A, { email: 'siti@kaki.test', telegram: 9001, lead: true })).id;
  foreign = (await contact(TENANT_B, { name: 'Elsewhere', email: 'siti@kaki.test' })).id;
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('Contact page and search (SCR-APP-016; AC-4)', () => {
  it('an Agent reads the page with identifiers, conversations, leads, consents and duplicates', async () => {
    const res = await call(asAgent, 'GET', `/api/v1/contacts/${keep}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: keep,
      label: 'Siti',
      mergedInto: null,
      identities: [
        { kind: 'email', value: 'siti@kaki.test', verified: false, source: 'lead_form' },
      ],
      conversationCount: 1,
      leads: [{ status: 'new', need: 'Cake', supersededBy: null }],
      consents: [{ purpose: 'enquiry', decision: 'agreed', wording: { text: 'To reply.' } }],
      duplicates: [{ contactId: other, shared: [{ kind: 'email', value: 'siti@kaki.test' }] }],
      merges: [],
      canMerge: true,
    });
    expect(body.conversations).toMatchObject([{ id: keepConversation, channel: 'widget' }]);
  });

  it("404s another tenant's or an unknown contact, and 401s without a session", async () => {
    expect((await call(asAgent, 'GET', `/api/v1/contacts/${foreign}`)).statusCode).toBe(404);
    expect((await call(asB, 'GET', `/api/v1/contacts/${keep}`)).statusCode).toBe(404);
    expect((await call(asAgent, 'GET', '/api/v1/contacts/not-a-uuid')).statusCode).toBe(404);
    expect((await call(null, 'GET', `/api/v1/contacts/${keep}`)).statusCode).toBe(401);
  });

  it('search takes the text in the body only and never crosses tenants', async () => {
    const res = await call(asAgent, 'POST', '/api/v1/contacts/search', {
      q: 'siti@',
      exclude: keep,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().contacts.map((c: { contactId: string }) => c.contactId)).toEqual([other]);
    expect((await call(asAgent, 'POST', '/api/v1/contacts/search', { q: 's' })).statusCode).toBe(
      422,
    );
    expect(
      (await call(asAgent, 'POST', '/api/v1/contacts/search', { q: 'siti', tenantId: TENANT_B }))
        .statusCode,
    ).toBe(422);
    const b = await call(asB, 'POST', '/api/v1/contacts/search', { q: 'siti' });
    expect(b.json().contacts.map((c: { contactId: string }) => c.contactId)).toEqual([foreign]);
  });

  it('the thread sidebar shows the verified marks and the duplicate hint', async () => {
    const res = await call(asAgent, 'GET', `/api/v1/conversations/${keepConversation}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().sidebar.contact).toMatchObject({
      contactId: keep,
      verified: { email: false, telegram: false },
      duplicates: 1,
    });
  });
});

describe('merge preview, merge and undo (UC-26 4a; AC-4–AC-7)', () => {
  it('previews, merges as an Agent, redirects the merged-away contact, and undoes once', async () => {
    const preview = await call(asAgent, 'GET', `/api/v1/contacts/${keep}/merge/${other}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      keep: { contactId: keep, conversationCount: 1, consent: { enquiry: 'agreed' } },
      merge: { contactId: other, conversationCount: 1 },
      after: {
        conversationCount: 2,
        leadOutcome: 'supersede',
        consent: { enquiry: 'agreed', marketing: null },
      },
    });
    expect(preview.json().after.identities.map((i: { kind: string }) => i.kind)).toEqual([
      'email',
      'telegram',
    ]);
    // Nothing was written by the preview.
    expect((await q(`select count(*)::int as n from contact_merges`)).rows[0]).toEqual({ n: 0 });

    expect(
      (await call(asB, 'POST', `/api/v1/contacts/${keep}/merge`, { otherId: other })).statusCode,
    ).toBe(404);
    expect(
      (await call(asAgent, 'POST', `/api/v1/contacts/${keep}/merge`, { otherId: foreign }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(asAgent, 'GET', `/api/v1/contacts/${keep}/merge/${foreign}`)).statusCode,
    ).toBe(404);
    expect(
      (await call(asAgent, 'POST', `/api/v1/contacts/${keep}/merge`, { otherId: keep })).json(),
    ).toEqual({ error: 'not_mergeable', reason: 'same_contact' });
    expect(
      (await call(asAgent, 'POST', `/api/v1/contacts/${keep}/merge`, { other })).statusCode,
    ).toBe(422);
    expect(
      (await call(null, 'POST', `/api/v1/contacts/${keep}/merge`, { otherId: other })).statusCode,
    ).toBe(401);

    const merged = await call(asAgent, 'POST', `/api/v1/contacts/${keep}/merge`, {
      otherId: other,
    });
    expect(merged.statusCode).toBe(200);
    const { mergeId, contact } = merged.json();
    expect(contact).toMatchObject({
      id: keep,
      conversationCount: 2,
      merges: [{ mergeId, otherContactId: other, by: expect.any(String), canUndo: true }],
    });
    expect(
      contact.leads.filter((l: { supersededBy: string | null }) => l.supersededBy),
    ).toHaveLength(1);
    const away = await call(asAgent, 'GET', `/api/v1/contacts/${other}`);
    expect(away.json()).toMatchObject({
      mergedInto: { contactId: keep, label: 'Siti', mergeId },
      conversations: [],
      leads: [],
    });
    const supersededId = contact.leads.find(
      (l: { supersededBy: string | null }) => l.supersededBy,
    ).id;
    expect(
      (await call(asAgent, 'GET', `/api/v1/leads/${supersededId}`)).json().supersededBy,
    ).toEqual(expect.any(String));
    expect((await call(asAgent, 'GET', `/api/v1/contacts/${other}/merge/${keep}`)).json()).toEqual({
      error: 'not_mergeable',
      reason: 'merged',
    });

    expect((await call(asB, 'POST', `/api/v1/contacts/merges/${mergeId}/undo`)).statusCode).toBe(
      404,
    );
    const undo = await call(asAgent, 'POST', `/api/v1/contacts/merges/${mergeId}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(undo.json().contact).toMatchObject({
      id: other,
      mergedInto: null,
      conversationCount: 1,
      leads: [{ supersededBy: null }],
    });
    const again = await call(asAgent, 'POST', `/api/v1/contacts/merges/${mergeId}/undo`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'undo_blocked', reason: 'already_undone' });
  });
});
