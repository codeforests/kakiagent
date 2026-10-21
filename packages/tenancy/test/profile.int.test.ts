/**
 * The business profile (FEAT-009 §5.1; AC-1, AC-5, AC-7, AC-8): saved by version on the
 * dashboard zone with the tenant's name and holiday exceptions, audited without values,
 * and read back by the visitor zone through `visitorTenantState`.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBusinessProfile,
  INDUSTRY_TEMPLATES,
  InvalidProfileError,
  questionKey,
  saveBusinessProfile,
  SettingsConflictError,
  sgDay,
  visitorTenantState,
  type ProfileInput,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
const TODAY = sgDay(new Date());
/** A Singapore day `n` days from today. */
const day = (n: number) => sgDay(new Date(Date.now() + n * 86_400_000));

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const read = (tenantId: string) => dash(tenantId, (tx) => getBusinessProfile(tx, tenantId, TODAY));
const save = (tenantId: string, version: number, profile: ProfileInput, today = TODAY) =>
  dash(tenantId, (tx) =>
    saveBusinessProfile(tx, { tenantId, userId: USER, version, profile, today }),
  );

const HOURS = {
  mon: [{ open: '08:00', close: '19:00' }],
  tue: [{ open: '08:00', close: '19:00' }],
  wed: [{ open: '08:00', close: '19:00' }],
  thu: [{ open: '08:00', close: '19:00' }],
  fri: [{ open: '08:00', close: '19:00' }],
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [],
};

const PROFILE: ProfileInput = {
  name: 'Second Tenant Cakes',
  uen: '201912345K',
  industry: 'fnb',
  contactEmail: 'hello@second.test',
  contactPhone: '+6591234567',
  languages: ['en', 'zh'],
  gstRegistered: true,
  hours: HOURS,
  openOnPublicHolidays: false,
  exceptions: [{ day: day(3), kind: 'closed', label: 'Staff day off' }],
};

const auditRows = async (tenantId: string) =>
  (
    await owner.query(
      `select event_type, actor_ref, payload from audit_entries
       where tenant_id = $1 and event_type = 'settings.profile_updated' order by seq`,
      [tenantId],
    )
  ).rows;

describe('business profile (FEAT-009)', () => {
  it('reads the profile every tenant has from sign-up', async () => {
    const p = await read(TENANT_B);
    expect(p).toMatchObject({
      version: 1,
      name: 'Second Tenant Pte Ltd',
      uen: null,
      industry: null,
      languages: ['en'],
      exceptions: [],
    });
  });

  it('saves the whole document, bumps the version and renames the tenant (AC-1)', async () => {
    const { version } = await read(TENANT_B);
    const saved = await save(TENANT_B, version, PROFILE);
    expect(saved).toMatchObject({ ...PROFILE, version: version + 1 });
    expect(await read(TENANT_B)).toEqual(saved);
    const { rows } = await owner.query(`select name from tenants where id = $1`, [TENANT_B]);
    expect(rows[0].name).toBe('Second Tenant Cakes');
    const state = await withTenant(tdb.zone('visitor'), TENANT_B, (tx) => visitorTenantState(tx));
    expect(state?.businessName).toBe('Second Tenant Cakes');
    expect(state?.gstRegistered).toBe(true);
    expect(state?.holidays).toEqual({ [day(3)]: 'closed' });
  });

  it('refuses a stale version and changes nothing (AC-1)', async () => {
    const before = await read(TENANT_B);
    await expect(
      save(TENANT_B, before.version - 1, { ...PROFILE, name: 'Stale' }),
    ).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await read(TENANT_B)).toEqual(before);
  });

  it('writes one audit entry with field codes and no values (AC-8)', async () => {
    const before = (await auditRows(TENANT_B)).length;
    const { version } = await read(TENANT_B);
    await save(TENANT_B, version, {
      ...PROFILE,
      contactPhone: '+6581234567',
      openOnPublicHolidays: true,
    });
    const rows = await auditRows(TENANT_B);
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1)!;
    expect(last.actor_ref).toBe(USER);
    expect(last.payload).toEqual({
      version: version + 1,
      fields: ['contact_phone', 'open_on_public_holidays'],
    });
    const text = JSON.stringify(rows);
    for (const v of ['8123', 'Second Tenant Cakes', '201912345K', 'hello@', 'Staff day'])
      expect(text).not.toContain(v);
  });

  it('replaces exceptions from today on and keeps past ones (AC-5)', async () => {
    await owner.query(
      `insert into holidays (tenant_id, day, kind, label) values ($1, $2, 'closed', 'Old')`,
      [TENANT_B, day(-30)],
    );
    const { version } = await read(TENANT_B);
    const saved = await save(TENANT_B, version, {
      ...PROFILE,
      exceptions: [{ day: day(10), kind: 'closed', label: null }],
    });
    expect(saved.exceptions).toEqual([{ day: day(10), kind: 'closed', label: null }]);
    const { rows } = await owner.query(
      `select day::text from holidays where tenant_id = $1 order by day`,
      [TENANT_B],
    );
    expect(rows.map((r) => r.day)).toEqual([day(-30), day(10)]);
  });

  it('drops redundant exceptions and refuses an open one on a normal day (AC-5)', async () => {
    const today = '2026-10-21';
    const { version } = await read(TENANT_B);
    const saved = await save(
      TENANT_B,
      version,
      {
        ...PROFILE,
        openOnPublicHolidays: false,
        exceptions: [
          { day: '2026-12-25', kind: 'open', label: null },
          { day: '2026-11-09', kind: 'closed', label: null }, // already closed by the rule
          { day: '2026-11-02', kind: 'closed', label: 'Stocktake' },
        ],
      },
      today,
    );
    expect(saved.exceptions.filter((e) => e.day >= today)).toEqual([
      { day: '2026-11-02', kind: 'closed', label: 'Stocktake' },
      { day: '2026-12-25', kind: 'open', label: null },
    ]);
    await expect(
      save(
        TENANT_B,
        saved.version,
        { ...PROFILE, exceptions: [{ day: '2026-11-03', kind: 'open', label: null }] },
        today,
      ),
    ).rejects.toBeInstanceOf(InvalidProfileError);
    await expect(
      save(
        TENANT_B,
        saved.version,
        { ...PROFILE, exceptions: [{ day: '2026-10-20', kind: 'closed', label: null }] },
        today,
      ),
    ).rejects.toBeInstanceOf(InvalidProfileError);
  });

  it("can't touch another tenant's profile", async () => {
    const a = await read(TENANT_A);
    await expect(
      dash(TENANT_B, (tx) =>
        saveBusinessProfile(tx, {
          tenantId: TENANT_A,
          userId: USER,
          version: a.version,
          profile: PROFILE,
          today: TODAY,
        }),
      ),
    ).rejects.toThrow();
    expect(await read(TENANT_A)).toEqual(a);
  });
});

describe('industry templates (FEAT-009 AC-7)', () => {
  it('has the F&B template only, with stable ids and questions', () => {
    expect(Object.keys(INDUSTRY_TEMPLATES)).toEqual(['fnb']);
    const faqs = INDUSTRY_TEMPLATES.fnb!.suggestedFaqs;
    expect(faqs.length).toBeGreaterThanOrEqual(10);
    expect(new Set(faqs.map((f) => f.id)).size).toBe(faqs.length);
    expect(faqs.every((f) => f.id.startsWith('fnb.') && f.question.endsWith('?'))).toBe(true);
  });

  it('compares questions without case, spaces or a trailing question mark', () => {
    expect(questionKey('  Do you take custom   cake orders? ')).toBe(
      questionKey('do you take custom cake orders'),
    );
    expect(questionKey('请问有清真认证吗？')).toBe('请问有清真认证吗');
  });
});
