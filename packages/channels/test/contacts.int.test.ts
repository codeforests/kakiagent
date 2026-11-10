/**
 * Contact identity (CHN-08; FEAT-039 §5.1, D2, D3, D5; AC-2, AC-3): verified identifiers
 * join one contact, unverified mail keeps its own mailbox contact and never a lead-form or
 * verified one, and `attachVerified` merges the other holder into the older contact.
 */
import { sql, withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addIdentity,
  attachVerified,
  resolveContact,
  undoMerge,
} from '../src/contacts/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const visitor = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('visitor'), TENANT_A, fn);
const email = (value: string, verified: boolean) =>
  ({ kind: 'email', value, source: 'email', verified }) as const;
const telegram = (value: string) =>
  ({ kind: 'telegram', value, source: 'telegram', verified: true }) as const;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('resolveContact (FEAT-039 §5.1)', () => {
  it('a verified From address joins the same contact every time', async () => {
    const a = await visitor((tx) => resolveContact(tx, TENANT_A, email('pass@kaki.test', true)));
    const b = await visitor((tx) =>
      resolveContact(tx, TENANT_A, email('pass@kaki.test', true), { name: 'Pass' }),
    );
    expect(b).toBe(a);
    const { rows } = await owner.query(`select email from contacts where id = $1`, [a]);
    expect(rows).toEqual([{ email: 'pass@kaki.test' }]);
  });

  it('unverified mail joins only the unverified mailbox contact, never a lead-form or verified one', async () => {
    const value = 'gray@kaki.test';
    // A widget visitor typed this address, and a verified mail came from it.
    const typed = await visitor(async (tx) => {
      const id = (
        await tx.execute<{ id: string }>(
          sql`insert into contacts (tenant_id, email) values (${TENANT_A}, ${value}) returning id`,
        )
      ).rows[0]!.id;
      await addIdentity(tx, TENANT_A, id, {
        kind: 'email',
        value,
        source: 'lead_form',
        verified: false,
      });
      return id;
    });
    const verified = await visitor((tx) => resolveContact(tx, TENANT_A, email(value, true)));
    const first = await visitor((tx) => resolveContact(tx, TENANT_A, email(value, false)));
    const again = await visitor((tx) => resolveContact(tx, TENANT_A, email(value, false)));
    expect(new Set([typed, verified, first]).size).toBe(3);
    expect(again).toBe(first);
  });

  it('one Telegram user ID is one contact', async () => {
    const a = await visitor((tx) =>
      resolveContact(tx, TENANT_A, telegram('7001'), { name: 'Tg', telegramUsername: 'tg' }),
    );
    const b = await visitor((tx) => resolveContact(tx, TENANT_A, telegram('7001')));
    expect(b).toBe(a);
    const { rows } = await owner.query(
      `select telegram_id::text as id, telegram_username from contacts where id = $1`,
      [a],
    );
    expect(rows).toEqual([{ id: '7001', telegram_username: 'tg' }]);
  });

  it('concurrent resolves of one verified value make one contact', async () => {
    const ids = await Promise.all(
      Array.from({ length: 4 }, () =>
        visitor((tx) => resolveContact(tx, TENANT_A, email('race@kaki.test', true))),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const { rows } = await owner.query(
      `select count(*)::int as n from contacts where tenant_id = $1 and email = 'race@kaki.test'`,
      [TENANT_A],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a typed value never resolves a contact', async () => {
    await expect(
      visitor((tx) =>
        resolveContact(tx, TENANT_A, {
          kind: 'phone',
          value: '+6591234567',
          source: 'lead_form',
          verified: false,
        }),
      ),
    ).rejects.toThrow(/only verified/);
  });
});

describe('attachVerified (FEAT-039 §5.1, D5; AC-3)', () => {
  it('merges the other holder into the older contact, audited as automatic, and can be undone', async () => {
    const older = await visitor((tx) => resolveContact(tx, TENANT_A, telegram('7100')));
    await owner.query(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id) values ($1, 'telegram', gen_random_uuid(), $2)`,
      [TENANT_A, older],
    );
    const widget = (
      await owner.query<{ id: string }>(
        `insert into contacts (tenant_id, name) values ($1, 'Widget visitor') returning id`,
        [TENANT_A],
      )
    ).rows[0]!.id;
    const out = await visitor((tx) => attachVerified(tx, TENANT_A, widget, telegram('7100')));
    expect(out).toEqual({ mergedFrom: widget, contactId: older });
    const merged = await owner.query(`select merged_into from contacts where id = $1`, [widget]);
    expect(merged.rows).toEqual([{ merged_into: older }]);
    // Attaching again to the survivor is a no-op.
    expect(await visitor((tx) => attachVerified(tx, TENANT_A, older, telegram('7100')))).toEqual({
      mergedFrom: null,
      contactId: older,
    });

    const audits = await owner.query<{ payload: Record<string, unknown>; id: string }>(
      `select payload, m.id from audit_entries a
       join contact_merges m on m.tenant_id = a.tenant_id and m.id::text = a.payload->>'mergeId'
       where a.tenant_id = $1 and a.event_type = 'contact.merged' and m.merged_id = $2`,
      [TENANT_A, widget],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.payload).toMatchObject({
      automatic: true,
      survivor: older,
      merged: widget,
      conversations: 0,
    });

    await visitor((tx) =>
      undoMerge(tx, { tenantId: TENANT_A, mergeId: audits.rows[0]!.id, actorId: null }),
    );
    const restored = await owner.query(`select merged_into from contacts where id = $1`, [widget]);
    expect(restored.rows).toEqual([{ merged_into: null }]);
  });

  it('with no holder it adds the identity and the display email', async () => {
    const widget = (
      await owner.query<{ id: string }>(
        `insert into contacts (tenant_id) values ($1) returning id`,
        [TENANT_A],
      )
    ).rows[0]!.id;
    const out = await visitor((tx) =>
      attachVerified(tx, TENANT_A, widget, email('linked@kaki.test', true)),
    );
    expect(out).toEqual({ mergedFrom: null, contactId: widget });
    const { rows } = await owner.query(
      `select k.email, i.source, i.verified_at is not null as verified from contacts k
       join contact_identities i on i.contact_id = k.id where k.id = $1`,
      [widget],
    );
    expect(rows).toEqual([{ email: 'linked@kaki.test', source: 'email', verified: true }]);
  });
});
