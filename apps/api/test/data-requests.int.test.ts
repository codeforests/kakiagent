/**
 * Data-subject request routes (FEAT-061 §3, §5.7; AC-1–AC-7): Owner and Admin can work a request,
 * an Agent gets 403 on every route, another tenant gets 404; export and erase need a fresh
 * re-auth; erase removes the subject, reports counts, its audit seq and the chain check, and the
 * detail shows when backups age out.
 */
import {
  DsrDetail,
  DsrEraseResult,
  DsrFindResult,
  DsrList,
  ReauthRequired,
  sgToday,
} from '@kaki/contracts';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import type { AnchorSource } from '@kaki/governance';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asAdmin: string;
let asAgent: string;
let asB: string;
let ownerId: string;
const EMAIL = 'mei.tan@example.com';
const contact = randomUUID();
const conv = randomUUID();

const anchors: AnchorSource = {
  list: async (tenantId) => {
    const r = await owner.query(`select seq, hash from audit_heads where tenant_id = $1`, [
      tenantId,
    ]);
    return r.rows.map((x) => ({ seq: Number(x.seq), hash: x.hash as string }));
  },
};

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const reauth = (fresh: boolean) =>
  owner.query(
    `update sessions set reauth_at = now() - ($2 || ' minutes')::interval where user_id = $1`,
    [ownerId, fresh ? '0' : '11'],
  );
const create = async (type: 'access' | 'deletion' | 'correction', cookie = asA) => {
  const res = await call('POST', '/api/v1/data-requests', cookie, {
    type,
    receivedOn: sgToday(),
    requester: { name: 'Mei Tan', email: EMAIL },
  });
  expect(res.statusCode, res.body).toBe(201);
  return DsrDetail.parse(res.json());
};
const verify = async (d: DsrDetail, cookie = asA) => {
  const res = await call('POST', `/api/v1/data-requests/${d.id}/verify`, cookie, {
    version: d.version,
    method: 'email_reply',
    note: 'Replied from the address on file',
  });
  expect(res.statusCode, res.body).toBe(200);
  return DsrDetail.parse(res.json());
};
const selection = {
  contactIds: [contact],
  conversationIds: [],
  factIds: [],
  stagedFactIds: [],
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { auditAnchors: anchors });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerId = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  for (const [email, role] of [
    ['admin@kaki-bakery.test', 'admin'],
    ['staff@kaki-bakery.test', 'agent'],
  ] as const) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email) values ($1) returning id`,
      [email],
    );
    await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
      TENANT_A,
      u.rows[0]!.id,
      role,
    ]);
  }
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAdmin = await sessionCookie(tdb, 'admin@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');

  await owner.query(
    `insert into contacts (tenant_id, id, name, email) values ($1, $2, 'Mei Tan', $3)`,
    [TENANT_A, contact, EMAIL],
  );
  await owner.query(
    `insert into contact_identities (tenant_id, contact_id, kind, value, source, verified_at)
     values ($1, $2, 'email', $3, 'email', now())`,
    [TENANT_A, contact, EMAIL],
  );
  await owner.query(
    `insert into conversations (tenant_id, id, channel, visitor_id, contact_id)
     values ($1, $2, 'widget', gen_random_uuid(), $3)`,
    [TENANT_A, conv, contact],
  );
  for (const [author, body] of [
    ['visitor', 'Hi, I want a birthday cake'],
    ['agent', 'Sure, what size?'],
  ])
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, $3, $4)`,
      [TENANT_A, conv, author, body],
    );
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('access (AC-1)', () => {
  it('Owner and Admin can log and list requests; due in 30 days', async () => {
    const d = await create('access');
    expect(d).toMatchObject({ status: 'open', source: 'dashboard', dueState: 'ok' });
    expect(d.ref).toMatch(/^DSR-[0-9A-F]{8}$/);
    const byAdmin = await create('access', asAdmin);
    const list = await call('GET', '/api/v1/data-requests?view=open', asAdmin);
    expect(list.statusCode).toBe(200);
    const ids = DsrList.parse(list.json()).items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([d.id, byAdmin.id]));
  });

  it('an Agent gets 403 on every route', async () => {
    const d = await create('deletion');
    const base = `/api/v1/data-requests/${d.id}`;
    const routes: [method: 'GET' | 'POST' | 'PATCH', url: string][] = [
      ['GET', '/api/v1/data-requests'],
      ['POST', '/api/v1/data-requests'],
      ['GET', base],
      ['PATCH', base],
      ['POST', `${base}/verify`],
      ['POST', `${base}/unverified`],
      ['POST', `${base}/close`],
      ['POST', `${base}/complete`],
      ['GET', `${base}/find`],
      ['POST', `${base}/export`],
      ['POST', `${base}/corrections`],
      ['POST', `${base}/erase`],
    ];
    for (const [method, url] of routes) {
      const res = await call(method, url, asAgent, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("another tenant gets 404 on this tenant's request and doesn't list it", async () => {
    const d = await create('deletion');
    expect((await call('GET', `/api/v1/data-requests/${d.id}`, asB)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/data-requests/${d.id}/find`, asB)).statusCode).toBe(404);
    const v = await call('POST', `/api/v1/data-requests/${d.id}/verify`, asB, {
      version: 1,
      method: 'other',
      note: 'x',
    });
    expect(v.statusCode).toBe(404);
    const list = DsrList.parse((await call('GET', '/api/v1/data-requests', asB)).json());
    expect(list.items.map((i) => i.id)).not.toContain(d.id);
    expect((await call('GET', '/api/v1/data-requests/not-a-uuid', asA)).statusCode).toBe(404);
  });
});

describe('verify, find and close (AC-2, AC-3)', () => {
  it('finds the contact on an open request (preview) and after verification', async () => {
    const d = await create('access');
    const preview = await call('GET', `/api/v1/data-requests/${d.id}/find`, asA);
    expect(preview.statusCode).toBe(200);
    const found = DsrFindResult.parse(preview.json());
    expect(found.contacts.map((c) => c.id)).toEqual([contact]);
    expect(found.conversations.map((c) => c.id)).toEqual([conv]);
    const v = await verify(d);
    expect(v.status).toBe('verified');
    expect(v.verification).toMatchObject({ method: 'email_reply', by: expect.any(String) });
    // Stale version → 409.
    const stale = await call('POST', `/api/v1/data-requests/${d.id}/close`, asA, {
      version: d.version,
      reason: 'duplicate',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('state_changed');
    const closed = await call('POST', `/api/v1/data-requests/${d.id}/close`, asA, {
      version: v.version,
      reason: 'Withdrawn by the customer',
    });
    expect(closed.statusCode).toBe(200);
    expect(DsrDetail.parse(closed.json()).status).toBe('closed');
    // A closed request can't be searched.
    expect((await call('GET', `/api/v1/data-requests/${d.id}/find`, asA)).statusCode).toBe(409);
  });

  it('a request with no identifier is 400', async () => {
    const res = await call('POST', '/api/v1/data-requests', asA, {
      type: 'access',
      receivedOn: sgToday(),
      requester: { name: 'No Contact' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('export (AC-4)', () => {
  it('needs a fresh re-auth, then downloads the JSON file', async () => {
    const d = await verify(await create('access'));
    await reauth(false);
    const body = { version: d.version, selection };
    const refused = await call('POST', `/api/v1/data-requests/${d.id}/export`, asA, body);
    expect(refused.statusCode).toBe(403);
    expect(ReauthRequired.parse(refused.json()).error).toBe('reauth_required');

    await reauth(true);
    const res = await call('POST', `/api/v1/data-requests/${d.id}/export`, asA, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="data-request-DSR-[0-9A-F]{8}-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = res.json();
    expect(file.conversations[0].messages.map((m: { body: string }) => m.body)).toEqual([
      'Hi, I want a birthday cake',
      'Sure, what size?',
    ]);
    // An ID outside the find result is 422 (D10).
    const bad = await call('POST', `/api/v1/data-requests/${d.id}/export`, asA, {
      version: d.version,
      selection: { ...selection, conversationIds: [randomUUID()] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('not_in_result');
  });
});

describe('correction (AC-5)', () => {
  it('changes the contact name without re-auth; access requests are 409 wrong_type', async () => {
    await reauth(false);
    const d = await verify(await create('correction'));
    const res = await call('POST', `/api/v1/data-requests/${d.id}/corrections`, asA, {
      version: d.version,
      contactId: contact,
      contact: { name: 'Mei Ling Tan' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const name = await owner.query(`select name from contacts where id = $1`, [contact]);
    expect(name.rows[0].name).toBe('Mei Ling Tan');
    const access = await verify(await create('access'));
    const wrong = await call('POST', `/api/v1/data-requests/${access.id}/corrections`, asA, {
      version: access.version,
      contactId: contact,
      contact: { name: 'X' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('wrong_type');
  });
});

describe('erase (AC-6, AC-7)', () => {
  it('needs re-auth, then deletes, reports counts and an intact chain, and backups clear in 35 days', async () => {
    const d = await verify(await create('deletion'));
    const body = { version: d.version, selection, confirm: 'delete' };
    await reauth(false);
    const refused = await call('POST', `/api/v1/data-requests/${d.id}/erase`, asA, body);
    expect(refused.statusCode).toBe(403);
    expect(ReauthRequired.parse(refused.json()).error).toBe('reauth_required');
    const exists = await owner.query(`select 1 from contacts where id = $1`, [contact]);
    expect(exists.rowCount).toBe(1);

    await reauth(true);
    const noConfirm = await call('POST', `/api/v1/data-requests/${d.id}/erase`, asA, {
      ...body,
      confirm: 'yes',
    });
    expect(noConfirm.statusCode).toBe(400);
    const res = await call('POST', `/api/v1/data-requests/${d.id}/erase`, asA, body);
    expect(res.statusCode, res.body).toBe(200);
    const out = DsrEraseResult.parse(res.json());
    expect(out.counts).toMatchObject({ contacts: 1, conversations: 1, messages: 2 });
    expect(out.auditSeq).toBeGreaterThan(0);
    expect(out.chain).toBe('intact');
    expect(out.detail.status).toBe('completed');
    expect(out.detail.requester.email).not.toBe(EMAIL);
    const completed = new Date(`${sgToday()}T00:00:00Z`);
    completed.setUTCDate(completed.getUTCDate() + 35);
    expect(out.detail.backupsClearBy).toBe(completed.toISOString().slice(0, 10));
    expect((await owner.query(`select 1 from contacts where id = $1`, [contact])).rowCount).toBe(0);
    expect(
      (await owner.query(`select 1 from messages where conversation_id = $1`, [conv])).rowCount,
    ).toBe(0);

    // A second erase on the completed request is 409.
    const again = await call('POST', `/api/v1/data-requests/${d.id}/erase`, asA, {
      ...body,
      version: out.detail.version,
    });
    expect(again.statusCode).toBe(409);
  });

  it('an access request is 409 wrong_type', async () => {
    await reauth(true);
    const d = await verify(await create('access'));
    const res = await call('POST', `/api/v1/data-requests/${d.id}/erase`, asA, {
      version: d.version,
      selection,
      confirm: 'delete',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('wrong_type');
  });
});
