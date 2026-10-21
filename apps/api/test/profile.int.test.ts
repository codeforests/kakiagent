/**
 * Business profile endpoints (FEAT-009 §3; AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-8).
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { isSgPublicHoliday, sgDay } from '@kaki/tenancy';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;

const URL = '/api/v1/settings/business-profile';
const DAY_MS = 86_400_000;
const day = (n: number) => sgDay(new Date(Date.now() + n * DAY_MS));
/** The next n-th day from tomorrow that is not an SG public holiday. */
function workday(from = 1) {
  for (let n = from; ; n++) if (!isSgPublicHoliday(day(n))) return day(n);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from holidays`);
});

const call = (method: 'GET' | 'PUT', who: string, payload?: unknown) =>
  app.inject({ method, url: URL, headers: { cookie: who }, ...(payload ? { payload } : {}) });

const HOURS = {
  mon: [{ open: '08:00', close: '19:00' }],
  tue: [{ open: '08:00', close: '19:00' }],
  wed: [{ open: '08:00', close: '19:00' }],
  thu: [{ open: '08:00', close: '19:00' }],
  fri: [{ open: '08:00', close: '19:00' }],
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [{ open: '18:00', close: '24:00' }],
};

async function current(who = asA) {
  return (await call('GET', who)).json();
}
async function body(over: Record<string, unknown> = {}) {
  const { profile } = await current();
  return {
    version: profile.version,
    name: 'Kaki Bakery',
    uen: '201912345k ',
    industry: 'fnb',
    contactEmail: 'hello@kaki-bakery.test',
    contactPhone: '9123 4567',
    languages: ['en', 'zh'],
    gstRegistered: true,
    hours: HOURS,
    openOnPublicHolidays: false,
    exceptions: [{ day: workday(), kind: 'closed', label: 'Staff day off' }],
    ...over,
  };
}

describe('GET /api/v1/settings/business-profile', () => {
  it('returns the profile, the coming holidays and the cover year (AC-4)', async () => {
    const res = await call('GET', asA);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.profile).toMatchObject({ name: 'Kaki Bakery', industry: 'fnb', languages: ['en', 'zh'] });
    expect(json.calendar.coverThrough).toBe(2027);
    const days: string[] = json.calendar.holidays.map((h: { day: string }) => h.day);
    expect(days.every((d) => d >= day(0) && d <= day(365))).toBe(true);
    expect(days.every(isSgPublicHoliday)).toBe(true);
    expect(json.calendar.holidays.every((h: { name: string }) => h.name.length > 0)).toBe(true);
  });

  it('is for the Owner and Admins only, and needs a session', async () => {
    expect((await call('GET', asAgent)).statusCode).toBe(403);
    expect((await call('PUT', asAgent, await body())).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
  });
});

describe('PUT /api/v1/settings/business-profile', () => {
  it('saves the whole profile, normalised, with version + 1 and the new name (AC-1)', async () => {
    const b = await body({ name: 'Kaki Bakery & Cafe' });
    const res = await call('PUT', asA, b);
    expect(res.statusCode).toBe(200);
    const { profile } = res.json();
    expect(profile).toMatchObject({
      version: b.version + 1,
      name: 'Kaki Bakery & Cafe',
      uen: '201912345K',
      contactPhone: '+6591234567',
      industry: 'fnb',
      exceptions: [{ day: workday(), kind: 'closed', label: 'Staff day off' }],
    });
    expect((await current()).profile).toEqual(profile);
    const { rows } = await owner.query(`select name from tenants where id = $1`, [TENANT_A]);
    expect(rows[0].name).toBe('Kaki Bakery & Cafe');
    await call('PUT', asA, await body());
  });

  it('refuses a stale version with 409 and changes nothing (AC-1)', async () => {
    const before = (await current()).profile;
    const res = await call('PUT', asA, { ...(await body({ name: 'Stale' })), version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('version_conflict');
    expect((await current()).profile).toEqual(before);
  });

  it.each([
    ['uen', '2019123K'],
    ['uen', '201912345'],
    ['uen', 'X08LL1234A'],
    ['uen', '2019-12345K'],
    ['uen', '20191234567'],
    ['contactPhone', '71234567'],
    ['contactPhone', '9123456'],
    ['contactPhone', '+60 12 345 6789'],
    ['contactEmail', 'not-an-email'],
    ['languages', []],
    ['industry', 'mining'],
    ['name', '  '],
  ])('rejects %s = %j with 400 (AC-2)', async (field, value) => {
    const res = await call('PUT', asA, await body({ [field]: value }));
    expect(res.statusCode).toBe(400);
  });

  it.each(['53312345A', '201912345K', 'T08LL1234A', 's99ab1234z'])(
    'accepts the UEN %s (AC-2)',
    async (uen) => {
      const res = await call('PUT', asA, await body({ uen }));
      expect(res.statusCode).toBe(200);
      expect(res.json().profile.uen).toBe(uen.toUpperCase());
    },
  );

  it.each([
    ['91234567', '+6591234567'],
    ['+65 6123 4567', '+6561234567'],
    ['8123-4567', '+6581234567'],
    ['', null],
  ])('stores the phone %j as %j (AC-2)', async (phone, stored) => {
    const res = await call('PUT', asA, await body({ contactPhone: phone }));
    expect(res.json().profile.contactPhone).toBe(stored);
  });

  it.each([
    ['open after close', { ...HOURS, mon: [{ open: '19:00', close: '08:00' }] }],
    [
      'overlap',
      {
        ...HOURS,
        mon: [
          { open: '08:00', close: '13:00' },
          { open: '12:00', close: '19:00' },
        ],
      },
    ],
    ['five ranges', { ...HOURS, mon: Array(5).fill({ open: '08:00', close: '09:00' }) }],
    ['a bad time', { ...HOURS, mon: [{ open: '8am', close: '19:00' }] }],
  ])('rejects hours with %s (AC-3)', async (_, hours) => {
    expect((await call('PUT', asA, await body({ hours }))).statusCode).toBe(400);
  });

  it('accepts a close of 24:00 and no hours at all (AC-3)', async () => {
    expect((await call('PUT', asA, await body())).json().profile.hours.sun).toEqual([
      { open: '18:00', close: '24:00' },
    ]);
    const none = await call('PUT', asA, await body({ hours: null }));
    expect(none.statusCode).toBe(200);
    expect(none.json().profile.hours).toBeNull();
    await call('PUT', asA, await body());
  });

  it('checks exceptions against the SG calendar and today (AC-5)', async () => {
    const holiday = (await current()).calendar.holidays[0]?.day as string | undefined;
    const bad = [
      [{ day: workday(), kind: 'open', label: null }],
      [{ day: day(-1), kind: 'closed', label: null }],
      [
        { day: workday(), kind: 'closed', label: null },
        { day: workday(), kind: 'closed', label: 'again' },
      ],
      [{ day: workday(), kind: 'closed', label: 'x'.repeat(61) }],
      ...(holiday ? [[{ day: holiday, kind: 'closed', label: null }]] : []),
    ];
    for (const exceptions of bad)
      expect((await call('PUT', asA, await body({ exceptions }))).statusCode).toBe(400);
    if (holiday) {
      const open = await call(
        'PUT',
        asA,
        await body({ exceptions: [{ day: holiday, kind: 'open', label: null }] }),
      );
      expect(open.statusCode).toBe(200);
      expect(open.json().profile.exceptions).toEqual([{ day: holiday, kind: 'open', label: null }]);
      const rule = await call(
        'PUT',
        asA,
        await body({
          openOnPublicHolidays: true,
          exceptions: [{ day: holiday, kind: 'closed', label: null }],
        }),
      );
      expect(rule.statusCode).toBe(200);
    }
  });

  it('writes one audit entry with field codes and no values (AC-8)', async () => {
    await call('PUT', asA, await body());
    const count = async () =>
      (
        await owner.query(
          `select payload from audit_entries where tenant_id = $1 and event_type = 'settings.profile_updated' order by seq`,
          [TENANT_A],
        )
      ).rows;
    const before = (await count()).length;
    await call('PUT', asA, await body({ contactPhone: '8123 4567', gstRegistered: false }));
    const rows = await count();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.payload.fields).toEqual(['contact_phone', 'gst_registered']);
    expect(JSON.stringify(rows)).not.toMatch(/8123|9123|201912345K|hello@|Staff day/);
  });
});

describe('the F&B template (AC-7)', () => {
  it('offers the suggested FAQs for F&B, marks one added, and none for other industries', async () => {
    await call('PUT', asA, await body({ industry: 'fnb' }));
    const first = (await current()).template;
    expect(first.industry).toBe('fnb');
    expect(first.suggestedFaqs.length).toBeGreaterThanOrEqual(10);
    expect(first.suggestedFaqs.every((f: { added: boolean }) => !f.added)).toBe(true);
    const { rows: before } = await owner.query(
      `select count(*)::int as n from facts where tenant_id = $1`,
      [TENANT_A],
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/facts',
      headers: { cookie: asA },
      payload: {
        type: 'faq',
        value: {
          question: '  do you take custom cake ORDERS ',
          answer: 'Yes, with 3 days notice.',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const after = (await current()).template.suggestedFaqs;
    expect(after.find((f: { id: string }) => f.id === 'fnb.custom-orders').added).toBe(true);
    expect(after.filter((f: { added: boolean }) => f.added)).toHaveLength(1);

    await call('PUT', asA, await body({ industry: 'retail' }));
    expect((await current()).template).toBeNull();
    // Choosing an industry wrote nothing to the KB.
    const { rows } = await owner.query(
      `select count(*)::int as n from facts where tenant_id = $1`,
      [TENANT_A],
    );
    expect(rows[0].n).toBe(before[0].n + 1);
  });

  it("is tenant B's own", async () => {
    expect((await current(asB)).template).toBeNull();
  });
});
