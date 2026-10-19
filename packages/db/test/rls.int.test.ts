/**
 * Cross-tenant RLS suite (GOV-03, ADR-005; plan §2 done-when 2). Every tenant-scoped
 * table must have forced RLS, a policy, and an entry in TENANT_SCOPED_TABLES; tenant
 * B's context can never read or write tenant A's rows, even with hand-written SQL.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_SCOPED_TABLES } from '../src/schema.js';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '../src/testing.js';

let tdb: TestDatabase;
let owner: pg.Client;

async function asRole<T>(
  role: 'app_dashboard' | 'app_agent_visitor',
  tenantId: string | null,
  fn: (c: pg.Client) => Promise<T>,
) {
  const c = new pg.Client({ connectionString: tdb.urlFor(role) });
  await c.connect();
  try {
    await c.query('begin');
    if (tenantId) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(c);
    await c.query('rollback');
    return out;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  // Seed one conversation and message per tenant, as the owner (bypasses RLS as superuser).
  for (const t of [TENANT_A, TENANT_B]) {
    const conv = await owner.query(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
      [t],
    );
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'visitor', $3)`,
      [t, conv.rows[0].id, `secret of ${t}`],
    );
  }
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('schema guard', () => {
  it('every table with tenant_id is forced-RLS, has a policy and is in the suite', async () => {
    const { rows } = await owner.query<{
      table: string;
      forced: boolean;
      enabled: boolean;
      policies: number;
    }>(`
      select c.relname as table, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (exists (select 1 from information_schema.columns col
                     where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id')
             or c.relname = 'tenants')`);
    expect(rows.map((r) => r.table).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
    for (const r of rows) {
      expect(r, r.table).toMatchObject({ enabled: true, forced: true });
      expect(r.policies, r.table).toBeGreaterThan(0);
    }
  });

  it('application roles neither own tables nor bypass RLS', async () => {
    const { rows } = await owner.query(
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_dashboard','app_agent_visitor','app_outbox')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      `select tablename from pg_tables where schemaname = 'public' and tableowner in ('app_dashboard','app_agent_visitor','app_outbox')`,
    );
    expect(owned.rows).toEqual([]);
  });
});

describe.each(['app_dashboard', 'app_agent_visitor'] as const)(
  'cross-tenant isolation as %s',
  (role) => {
    it("tenant B's context cannot read tenant A's messages, even with a hand-written query", async () => {
      const rows = await asRole(
        role,
        TENANT_B,
        async (c) =>
          (await c.query(`select tenant_id, body from messages where tenant_id = $1`, [TENANT_A]))
            .rows,
      );
      expect(rows).toEqual([]);
      const own = await asRole(
        role,
        TENANT_B,
        async (c) => (await c.query(`select tenant_id from messages`)).rows,
      );
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    });

    it("cannot read tenant A's conversations", async () => {
      const rows = await asRole(
        role,
        TENANT_B,
        async (c) =>
          (await c.query(`select id from conversations where tenant_id = $1`, [TENANT_A])).rows,
      );
      expect(rows).toEqual([]);
    });

    it('sees nothing when no tenant context is set (fail closed)', async () => {
      const rows = await asRole(
        role,
        null,
        async (c) => (await c.query(`select id from messages`)).rows,
      );
      expect(rows).toEqual([]);
    });
  },
);

describe('cross-tenant writes', () => {
  it("visitor role in tenant B cannot insert into tenant A's conversation", async () => {
    const convA = (
      await owner.query(`select id from conversations where tenant_id = $1 limit 1`, [TENANT_A])
    ).rows[0].id;
    await expect(
      asRole('app_agent_visitor', TENANT_B, (c) =>
        c.query(
          `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'visitor', 'x')`,
          [TENANT_A, convA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('visitor role cannot read the tenants table directly', async () => {
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from tenants`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('the widget-key resolver returns only the matching tenant', async () => {
    const rows = await asRole(
      'app_agent_visitor',
      null,
      async (c) => (await c.query(`select * from resolve_widget_key('wk_dev_bakery')`)).rows,
    );
    expect(rows).toEqual([
      { tenant_id: TENANT_A, allowed_origins: ['http://localhost:5175'], status: 'active' },
    ]);
    const none = await asRole(
      'app_agent_visitor',
      null,
      async (c) => (await c.query(`select * from resolve_widget_key('nope')`)).rows,
    );
    expect(none).toEqual([]);
  });
});
