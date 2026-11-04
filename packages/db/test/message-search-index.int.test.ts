/**
 * The message search index (FEAT-046 §4, D5; AC-1): `pg_trgm` + `btree_gin` and one
 * composite GIN index on `messages (tenant_id, body gin_trgm_ops)`.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing.js';

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

describe('messages_search_trgm_idx', () => {
  it('installs both extensions', async () => {
    const { rows } = await owner.query(
      `select extname from pg_extension where extname in ('pg_trgm', 'btree_gin') order by extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['btree_gin', 'pg_trgm']);
  });

  it('is a GIN index on tenant_id then body with trigram ops', async () => {
    const { rows } = await owner.query(
      `select indexdef from pg_indexes where tablename = 'messages' and indexname = 'messages_search_trgm_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/USING gin \(tenant_id, body gin_trgm_ops\)/);
  });
});
