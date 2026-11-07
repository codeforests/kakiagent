/**
 * The dev seed (FEAT-050 §5.7): the bakery gets four contact-form leads with their consents and
 * scoring criteria; the second tenant none; a second run changes nothing.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devTenants, seed, SEED_LEADS, SEED_QUALIFICATION } from '../src/setup.js';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '../src/testing.js';

let tdb: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const snapshot = async () => ({
  leads: (
    await owner.query(
      `select tenant_id, status, score, score_points, conversation_id, hot_alerted_at is not null as alerted
       from leads order by tenant_id, created_at`,
    )
  ).rows,
  contacts: (await owner.query(`select count(*)::int n from contacts`)).rows[0].n,
  consents: (
    await owner.query(`select purpose, decision from consents order by created_at, purpose`)
  ).rows,
  qualification: (
    await owner.query(`select tenant_id, qualification from lead_settings order by tenant_id`)
  ).rows,
});

describe('dev seed leads (FEAT-050 §5.7)', () => {
  it('seeds the bakery leads once, without conversations; the second tenant has none', async () => {
    await seed(owner, devTenants(['http://localhost:5175']));
    const first = await snapshot();
    expect(first.leads.filter((l) => l.tenant_id === TENANT_B)).toEqual([]);
    const bakery = first.leads.filter((l) => l.tenant_id === TENANT_A);
    expect(bakery).toHaveLength(SEED_LEADS.length);
    expect(bakery.every((l) => l.conversation_id === null)).toBe(true);
    expect(bakery.map((l) => [l.status, l.score]).sort()).toEqual(
      SEED_LEADS.map((l) => [l.status, l.score.score]).sort(),
    );
    expect(bakery.filter((l) => l.alerted)).toHaveLength(1); // the hot one: no alert to send
    expect(first.contacts).toBe(SEED_LEADS.length);
    expect(first.consents.filter((c) => c.purpose === 'marketing')).toHaveLength(2);
    expect(first.qualification).toEqual([
      { tenant_id: TENANT_A, qualification: SEED_QUALIFICATION },
      { tenant_id: TENANT_B, qualification: { keywords: [], minBudget: null } },
    ]);

    await seed(owner, devTenants(['http://localhost:5175']));
    expect(await snapshot()).toEqual(first);
  });
});
