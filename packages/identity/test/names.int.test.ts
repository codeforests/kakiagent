/** Member display names for the inbox's thread dividers (FEAT-042 D7). */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberNames } from '../src/index.js';

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

async function user(email: string, displayName: string | null, tenantId: string) {
  const r = await owner.query(
    `insert into users (email, display_name) values ($1, $2) returning id`,
    [email, displayName],
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    tenantId,
    r.rows[0].id,
  ]);
  return r.rows[0].id as string;
}

describe('memberNames (FEAT-042 D7)', () => {
  it("names the tenant's members by display name, else the email's local part", async () => {
    const named = await user('mei.lin@example.test', 'Mei Lin', TENANT_A);
    const plain = await user('ahmad@example.test', null, TENANT_A);
    const elsewhere = await user('b-only@example.test', 'B Only', TENANT_B);
    const names = await withTenant(tdb.zone('identity'), TENANT_A, (tx) =>
      memberNames(tx, [named, plain, elsewhere, named]),
    );
    expect(Object.fromEntries(names)).toEqual({ [named]: 'Mei Lin', [plain]: 'ahmad' });
    const none = await withTenant(tdb.zone('identity'), TENANT_A, (tx) => memberNames(tx, []));
    expect(none.size).toBe(0);
  });
});
