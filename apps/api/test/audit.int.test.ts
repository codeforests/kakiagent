import { AuditPage, AuditRow, AuditVerifyResult, ReauthRequired } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { audit, type AnchorSource } from '@kaki/governance';
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
let closedSeq: number;
let closedHash: string;
const C1 = '00000000-0000-4000-8000-0000000000c1';

/** Anchors at the current head, as the scheduler would have written them. */
const anchors: AnchorSource = {
  list: async (tenantId) => {
    const r = await owner.query(`select seq, hash from audit_heads where tenant_id = $1`, [
      tenantId,
    ]);
    return r.rows.map((x) => ({ seq: Number(x.seq), hash: x.hash as string }));
  },
};

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const exportedCount = async () =>
  Number(
    (
      await owner.query(
        `select count(*) as n from audit_entries where tenant_id = $1 and event_type = 'audit.exported'`,
        [TENANT_A],
      )
    ).rows[0].n,
  );
const freshReauth = () =>
  owner.query(`update sessions set reauth_at = now() where user_id = $1`, [ownerId]);

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
  const closed = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    audit.append(tx, TENANT_A, {
      action: 'conversation.closed',
      actorType: 'user',
      actorId: ownerId,
      subjectType: 'conversation',
      subjectId: C1,
    }),
  );
  closedSeq = closed.seq;
  closedHash = closed.hash;
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    audit.append(tx, TENANT_A, {
      action: 'fact.updated',
      actorType: 'user',
      actorId: ownerId,
      subjectType: 'fact',
      subjectId: '00000000-0000-4000-8000-0000000000f1',
    }),
  );
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('audit log routes (FEAT-060 AC-1, AC-2)', () => {
  it('Owner and Admin list entries newest first; Agents get 403 on every route', async () => {
    for (const who of [asA, asAdmin]) {
      const res = await call('GET', '/api/v1/audit/entries?limit=5', who);
      expect(res.statusCode).toBe(200);
      const page = AuditPage.parse(res.json());
      expect(page.entries.length).toBeGreaterThan(0);
      const seqs = page.entries.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    }
    for (const [m, url] of [
      ['GET', '/api/v1/audit/entries'],
      ['GET', `/api/v1/audit/entries/${closedSeq}`],
      ['GET', '/api/v1/audit/filters'],
      ['GET', '/api/v1/audit/verification'],
      ['POST', '/api/v1/audit/verify'],
      ['POST', '/api/v1/audit/export'],
    ] as const) {
      const res = await call(m, url, asAgent, m === 'POST' ? { format: 'csv' } : undefined);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('filters by conversation and names the member; one entry by seq; 404 and 400', async () => {
    const res = await call('GET', `/api/v1/audit/entries?conversation=${C1}`, asA);
    const page = AuditPage.parse(res.json());
    expect(page.entries.map((e) => e.eventType)).toEqual(['conversation.closed']);
    expect(page.entries[0]).toMatchObject({
      seq: closedSeq,
      actorId: ownerId,
      group: 'conversations',
      subjects: [{ type: 'conversation', id: C1 }],
      pii: 'none',
    });
    expect(page.entries[0]!.actorName).toEqual(expect.any(String));
    const group = AuditPage.parse(
      (await call('GET', '/api/v1/audit/entries?group=knowledge', asA)).json(),
    );
    expect(group.entries.every((e) => e.group === 'knowledge')).toBe(true);

    const one = await call('GET', `/api/v1/audit/entries/${closedSeq}`, asA);
    expect(one.statusCode).toBe(200);
    expect(AuditRow.parse(one.json()).hash).toBe(closedHash);
    expect((await call('GET', '/api/v1/audit/entries/999999', asA)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/audit/entries/abc', asA)).statusCode).toBe(404);
    expect(
      (await call('GET', '/api/v1/audit/entries?from=2026-11-14&to=2026-11-13', asA)).statusCode,
    ).toBe(400);
    expect(
      (await call('GET', `/api/v1/audit/entries?actor=${ownerId}&actorType=agent`, asA)).statusCode,
    ).toBe(400);
    expect((await call('GET', '/api/v1/audit/entries?limit=101', asA)).statusCode).toBe(400);
  });

  it('filter options list the current members', async () => {
    const res = await call('GET', '/api/v1/audit/filters', asA);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { members: { id: string }[] }).members.map((m) => m.id);
    expect(ids).toContain(ownerId);
    expect(ids).toHaveLength(3);
  });
});

describe('verify (FEAT-060 AC-3)', () => {
  it('verifies against the anchors, then refuses a second run within 30 s; the last run is readable', async () => {
    expect(
      (await call('GET', '/api/v1/audit/verification', asA)).json() as { last: unknown },
    ).toEqual({ last: null });
    const res = await call('POST', '/api/v1/audit/verify', asA);
    expect(res.statusCode).toBe(200);
    const r = AuditVerifyResult.parse(res.json());
    expect(r).toMatchObject({ ok: true, anchors: 'checked', anchorsChecked: 1, broken: null });
    expect(r.checked).toBe(r.headSeq);

    const again = await call('POST', '/api/v1/audit/verify', asAdmin);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'verify_cooldown' });
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);

    const last = (await call('GET', '/api/v1/audit/verification', asA)).json() as {
      last: { ok: boolean; headSeq: number; by: string | null };
    };
    expect(last.last).toMatchObject({ ok: true, headSeq: r.headSeq });
    expect(last.last.by).toEqual(expect.any(String));
  });
});

describe('export (FEAT-060 AC-4)', () => {
  it('needs a fresh re-auth', async () => {
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [ownerId],
    );
    const res = await call('POST', '/api/v1/audit/export', asA, { format: 'csv' });
    expect(res.statusCode).toBe(403);
    expect(ReauthRequired.parse(res.json()).error).toBe('reauth_required');
  });

  it('downloads CSV and JSON with the filter honoured and one audit.exported each', async () => {
    await freshReauth();
    const before = await exportedCount();
    const csv = await call('POST', '/api/v1/audit/export', asA, {
      format: 'csv',
      conversation: C1,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csv.headers['cache-control']).toBe('no-store');
    const lines = csv.body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('conversation.closed');
    expect(lines[1]).toContain(closedHash);
    expect(await exportedCount()).toBe(before + 1);

    const json = await call('POST', '/api/v1/audit/export', asA, { format: 'json' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['content-disposition']).toMatch(/\.json"$/);
    const body = json.json() as { count: number; entries: { event_type: string }[] };
    expect(body.count).toBe(body.entries.length);
    expect(body.entries.map((e) => e.event_type)).toContain('fact.updated');
    // The export that is running isn't in its own file; the earlier one is.
    expect(body.entries.filter((e) => e.event_type === 'audit.exported')).toHaveLength(1);
    expect(await exportedCount()).toBe(before + 2);
  });

  it('answers 413 too_many above the cap', async () => {
    const small = await testApp(tdb, { auditAnchors: anchors, auditExportMax: 1 });
    try {
      await freshReauth();
      const res = await small.inject({
        method: 'POST',
        url: '/api/v1/audit/export',
        headers: { cookie: asA },
        payload: { format: 'csv' },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: 'too_many', max: 1 });
    } finally {
      await small.close();
    }
  });
});

describe('tenant isolation (FEAT-060 AC-1)', () => {
  it("tenant B's session sees none of tenant A's entries and can't fetch A's seq", async () => {
    const page = AuditPage.parse((await call('GET', '/api/v1/audit/entries', asB)).json());
    expect(page.entries.map((e) => e.hash)).not.toContain(closedHash);
    const one = await call('GET', `/api/v1/audit/entries/${closedSeq}`, asB);
    if (one.statusCode === 200) expect(AuditRow.parse(one.json()).hash).not.toBe(closedHash);
    else expect(one.statusCode).toBe(404);
    const conv = AuditPage.parse(
      (await call('GET', `/api/v1/audit/entries?conversation=${C1}`, asB)).json(),
    );
    expect(conv.entries).toEqual([]);
  });
});
