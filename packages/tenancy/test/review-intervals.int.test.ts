/** Review intervals (KB-17; FEAT-018 §5.2, AC-5, AC-9): per type, 1–24, default 6, audited. */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewIntervals, saveReviewIntervals } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';

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

describe('review intervals', () => {
  it('default to 6 months for every type', async () => {
    expect(await dash(TENANT_A, (tx) => reviewIntervals(tx, TENANT_A))).toEqual({
      product: 6,
      faq: 6,
      policy: 6,
      promotion: 6,
    });
  });

  it("save per type for the tenant's own row only, audited with the numbers", async () => {
    const next = { product: 3, faq: 12, policy: 24, promotion: 1 };
    expect(await dash(TENANT_B, (tx) => saveReviewIntervals(tx, TENANT_B, USER, next))).toEqual(
      next,
    );
    expect(await dash(TENANT_B, (tx) => reviewIntervals(tx, TENANT_B))).toEqual(next);
    expect((await dash(TENANT_A, (tx) => reviewIntervals(tx, TENANT_A))).product).toBe(6);
    const { rows } = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'kb.review_intervals.changed'`,
      [TENANT_B],
    );
    expect(rows).toEqual([{ payload: next }]);
  });

  it('reject 0, 25 and fractions', async () => {
    for (const bad of [0, 25, 1.5])
      await expect(
        dash(TENANT_A, (tx) =>
          saveReviewIntervals(tx, TENANT_A, USER, {
            product: bad,
            faq: 6,
            policy: 6,
            promotion: 6,
          }),
        ),
      ).rejects.toThrow();
  });
});
