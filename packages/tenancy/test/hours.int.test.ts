/**
 * Opening hours through the visitor zone (FEAT-023 §5.1; AC-6, AC-10): the turn reads
 * them with `visitorTenantState`, never from `business_profiles` directly.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { visitorTenantState } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const HOURS = {
  mon: [{ open: '08:00', close: '19:00' }],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [],
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const state = (tenantId: string) =>
  withTenant(tdb.zone('visitor'), tenantId, (tx) => visitorTenantState(tx));

describe('visitorTenantState hours (FEAT-023)', () => {
  it('returns valid hours and the holiday flag', async () => {
    await owner.query(
      `update business_profiles set hours = $2, open_on_public_holidays = true where tenant_id = $1`,
      [TENANT_B, HOURS],
    );
    const s = await state(TENANT_B);
    expect(s?.hours).toEqual(HOURS);
    expect(s?.openOnPublicHolidays).toBe(true);
  });

  it('treats hours that fail validation as not set', async () => {
    await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
      TENANT_B,
      { mon: [{ open: '19:00', close: '08:00' }] },
    ]);
    expect((await state(TENANT_B))?.hours).toBeNull();
  });

  it('reads null hours as not set', async () => {
    await owner.query(`update business_profiles set hours = null where tenant_id = $1`, [TENANT_B]);
    expect((await state(TENANT_B))?.hours).toBeNull();
    expect((await state(TENANT_A))?.businessName).toBe('Kaki Bakery');
  });
});
