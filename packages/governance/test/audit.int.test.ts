import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/index.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await startTestDatabase();
});
afterAll(async () => tdb?.stop());

describe('audit.append', () => {
  it('writes an IDs-only row in the caller tenant and cannot write into another tenant', async () => {
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      audit.append(tx, TENANT_A, {
        action: 'test.done',
        actorType: 'user',
        actorId: 'u1',
        subjectType: 'thing',
        subjectId: 't1',
      }),
    );
    await expect(
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        audit.append(tx, TENANT_B, {
          action: 'test.cross',
          actorType: 'system',
          subjectType: 'thing',
          subjectId: 't2',
        }),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    const rows = (await c.query(`select tenant_id, action, actor_id from audit_events`)).rows;
    await c.end();
    expect(rows).toEqual([{ tenant_id: TENANT_A, action: 'test.done', actor_id: 'u1' }]);
  });
});
