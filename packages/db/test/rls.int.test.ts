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
  role: 'app_dashboard' | 'app_agent_visitor' | 'app_outbox' | 'app_identity',
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
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_dashboard','app_agent_visitor','app_outbox','app_identity')`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      `select tablename from pg_tables where schemaname = 'public' and tableowner in ('app_dashboard','app_agent_visitor','app_outbox','app_identity')`,
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

// ---- FEAT-022: facts, chunks and the visitor views (ADR-009, ADR-010; AC-6) ----------

const VEC = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;

/** One fact per lifecycle case for each tenant, with a chunk each. Returns name → id. */
async function seedFacts(tenantId: string) {
  const cases: [string, string, string | null, string | null][] = [
    // name, status, gst_treatment, valid_until
    ['approved', 'approved', 'inclusive', null],
    ['needs_review', 'needs_review', 'inclusive', null],
    ['rejected', 'rejected', 'inclusive', null],
    ['conflicted', 'conflicted', 'inclusive', null],
    ['disabled', 'disabled', 'inclusive', null],
    ['expired', 'approved', 'inclusive', '2020-01-01T00:00:00Z'],
    ['gst_unknown', 'approved', 'unknown', null],
  ];
  const ids: Record<string, string> = {};
  for (const [name, status, gst, validUntil] of cases) {
    const { rows } = await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment, valid_until)
       values ($1, 'product', $2, $3, $4, $5) returning id`,
      [
        tenantId,
        status,
        { name: `${name} of ${tenantId}`, priceCents: 5500, currency: 'SGD' },
        gst,
        validUntil,
      ],
    );
    ids[name] = rows[0].id;
    await owner.query(
      `insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment)
       select tenant_id, id, version, status, value, gst_treatment from facts where tenant_id = $1 and id = $2`,
      [tenantId, rows[0].id],
    );
    await owner.query(
      `insert into kb_chunks (tenant_id, fact_id, fact_version, content, embedding) values ($1, $2, 1, $3, $4)`,
      [tenantId, rows[0].id, name, VEC],
    );
  }
  return ids;
}

describe('facts and the visitor views', () => {
  let factsA: Record<string, string>;
  let factsB: Record<string, string>;
  beforeAll(async () => {
    factsA = await seedFacts(TENANT_A);
    factsB = await seedFacts(TENANT_B);
  });

  it.each(['facts', 'fact_versions', 'kb_chunks', 'business_profiles'])(
    'the visitor role cannot read the base table %s',
    async (table) => {
      await expect(
        asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from ${table}`)),
      ).rejects.toThrow(/permission denied/);
    },
  );

  it('visitor_facts holds only approved, enabled, unexpired, quotable facts of the tenant', async () => {
    const rows = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) => (await c.query(`select tenant_id, id from visitor_facts`)).rows,
    );
    expect(rows).toEqual([{ tenant_id: TENANT_A, id: factsA.approved }]);
  });

  it('GST-unknown prices are hidden only at a GST-registered tenant (KB-15)', async () => {
    // Tenant B (second tenant) is not GST-registered, so its GST-unknown price is usable.
    const rows = await asRole(
      'app_agent_visitor',
      TENANT_B,
      async (c) => (await c.query(`select id from visitor_facts order by id`)).rows,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([factsB.approved, factsB.gst_unknown].sort());
  });

  it("tenant B's context never sees tenant A's facts or chunks, even when asked by ID", async () => {
    const facts = await asRole(
      'app_agent_visitor',
      TENANT_B,
      async (c) =>
        (
          await c.query(`select id from visitor_facts where tenant_id = $1 or id = $2`, [
            TENANT_A,
            factsA.approved,
          ])
        ).rows,
    );
    expect(facts).toEqual([]);
    const chunks = await asRole(
      'app_agent_visitor',
      TENANT_B,
      async (c) =>
        (await c.query(`select fact_id from visitor_chunks where tenant_id = $1`, [TENANT_A])).rows,
    );
    expect(chunks).toEqual([]);
  });

  it('visitor_chunks returns chunks of visible facts only, and only at their current version', async () => {
    const rows = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) =>
        (
          await c.query(`select fact_id from visitor_chunks order by embedding <=> $1 limit 10`, [
            VEC,
          ])
        ).rows,
    );
    expect(rows).toEqual([{ fact_id: factsA.approved }]);
    // A newer fact version makes the old chunk unsearchable until it is re-embedded.
    await owner.query(`update facts set version = 2 where tenant_id = $1 and id = $2`, [
      TENANT_A,
      factsA.approved,
    ]);
    const stale = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) => (await c.query(`select fact_id from visitor_chunks`)).rows,
    );
    expect(stale).toEqual([]);
    await owner.query(`update facts set version = 1 where tenant_id = $1 and id = $2`, [
      TENANT_A,
      factsA.approved,
    ]);
  });

  it('the views return nothing without a tenant context (fail closed)', async () => {
    const rows = await asRole(
      'app_agent_visitor',
      null,
      async (c) =>
        (await c.query(`select id from visitor_facts union all select id from visitor_chunks`))
          .rows,
    );
    expect(rows).toEqual([]);
  });

  it('the dashboard role reads and writes only its own tenant facts', async () => {
    const rows = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) => (await c.query(`select id from facts where tenant_id = $1`, [TENANT_A])).rows,
    );
    expect(rows).toEqual([]);
    await expect(
      asRole('app_dashboard', TENANT_B, (c) =>
        c.query(
          `insert into facts (tenant_id, type, status, value) values ($1, 'faq', 'approved', '{}')`,
          [TENANT_A],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asRole('app_dashboard', TENANT_B, async (c) => {
      const r = await c.query(`update facts set status = 'disabled' where tenant_id = $1`, [
        TENANT_A,
      ]);
      return r.rowCount;
    });
    expect(updated).toBe(0);
  });

  it('fact versions are append-only for the dashboard role', async () => {
    await expect(
      asRole('app_dashboard', TENANT_A, (c) =>
        c.query(`update fact_versions set status = 'approved'`),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('visitor_tenant_state returns the current tenant only, and nothing without context', async () => {
    const a = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) => (await c.query(`select * from visitor_tenant_state()`)).rows,
    );
    expect(a).toEqual([
      {
        ai_paused: false,
        business_name: 'Kaki Bakery',
        gst_registered: true,
        route_complexity_threshold: 0.6,
        route_min_confidence: 0.5,
        cost_governor_step: 0,
      },
    ]);
    const none = await asRole(
      'app_agent_visitor',
      null,
      async (c) => (await c.query(`select * from visitor_tenant_state()`)).rows,
    );
    expect(none).toEqual([]);
  });
});

// ---- FEAT-011: deletion, the new fact types and validity (FEAT-011 §4; AC-3, AC-5, AC-7) --

/** Inserts a fact with its version and chunk as the owner; returns its id. */
async function seedFact(
  tenantId: string,
  f: {
    type: string;
    value: object;
    gst?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
  },
) {
  const { rows } = await owner.query(
    `insert into facts (tenant_id, type, status, value, gst_treatment, valid_from, valid_until)
     values ($1, $2, 'approved', $3, $4, $5, $6) returning id`,
    [tenantId, f.type, f.value, f.gst ?? null, f.validFrom ?? null, f.validUntil ?? null],
  );
  const id = rows[0].id as string;
  await owner.query(
    `insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment, valid_from, valid_until)
     select tenant_id, id, version, status, value, gst_treatment, valid_from, valid_until from facts where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  await owner.query(
    `insert into kb_chunks (tenant_id, fact_id, fact_version, content, embedding) values ($1, $2, 1, 'x', $3)`,
    [tenantId, id, VEC],
  );
  return id;
}

const visibleIds = async (tenantId: string) =>
  asRole('app_agent_visitor', tenantId, async (c) =>
    (await c.query(`select id from visitor_facts`)).rows.map((r) => r.id as string),
  );

describe('fact deletion, policy and promotion facts, validity (FEAT-011)', () => {
  const promo = { title: 'Bundle', details: 'Two boxes', priceCents: 2000, currency: 'SGD' };
  const hour = 3600_000;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('the dashboard role deletes its own fact, chunk and versions, and nothing of another tenant', async () => {
    const id = await seedFact(TENANT_A, {
      type: 'policy',
      value: { kind: 'refund', title: 'Refunds', details: 'Within a week' },
    });
    const crossTenant = await asRole('app_dashboard', TENANT_B, async (c) => {
      const counts = [];
      for (const t of ['kb_chunks', 'fact_versions', 'facts']) {
        const col = t === 'facts' ? 'id' : 'fact_id';
        counts.push((await c.query(`delete from ${t} where ${col} = $1`, [id])).rowCount);
      }
      return counts;
    });
    expect(crossTenant).toEqual([0, 0, 0]);
    const own = await asRole('app_dashboard', TENANT_A, async (c) => {
      const counts = [];
      for (const t of ['kb_chunks', 'fact_versions', 'facts']) {
        const col = t === 'facts' ? 'id' : 'fact_id';
        counts.push((await c.query(`delete from ${t} where ${col} = $1`, [id])).rowCount);
      }
      return counts;
    });
    expect(own).toEqual([1, 1, 1]);
  });

  it.each(['facts', 'fact_versions', 'kb_chunks'])(
    'the visitor role cannot delete from %s',
    async (table) => {
      await expect(
        asRole('app_agent_visitor', TENANT_A, (c) => c.query(`delete from ${table}`)),
      ).rejects.toThrow(/permission denied/);
    },
  );

  it('visitor_facts applies promotion validity and exposes the validity columns', async () => {
    const running = await seedFact(TENANT_A, {
      type: 'promotion',
      value: promo,
      gst: 'inclusive',
      validFrom: at(-hour),
      validUntil: at(hour),
    });
    const notStarted = await seedFact(TENANT_A, {
      type: 'promotion',
      value: promo,
      gst: 'inclusive',
      validFrom: at(hour),
      validUntil: at(2 * hour),
    });
    const ended = await seedFact(TENANT_A, {
      type: 'promotion',
      value: promo,
      gst: 'inclusive',
      validUntil: at(-hour),
    });
    const ids = await visibleIds(TENANT_A);
    expect(ids).toContain(running);
    expect(ids).not.toContain(notStarted);
    expect(ids).not.toContain(ended);
    const [row] = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) =>
        (
          await c.query(`select valid_from, valid_until from visitor_facts where id = $1`, [
            running,
          ])
        ).rows,
    );
    expect(row.valid_until).toBeInstanceOf(Date);
  });

  it('a GST-unknown promotion price is hidden at a registered tenant only; policies and FAQs have no GST', async () => {
    const a = await seedFact(TENANT_A, {
      type: 'promotion',
      value: promo,
      gst: 'unknown',
      validUntil: at(hour),
    });
    const b = await seedFact(TENANT_B, {
      type: 'promotion',
      value: promo,
      gst: 'unknown',
      validUntil: at(hour),
    });
    const policy = await seedFact(TENANT_A, {
      type: 'policy',
      value: { kind: 'delivery', title: 'Delivery', details: 'Islandwide' },
    });
    expect(await visibleIds(TENANT_A)).not.toContain(a);
    expect(await visibleIds(TENANT_A)).toContain(policy);
    expect(await visibleIds(TENANT_B)).toContain(b);
  });

  it.each([
    [
      'a policy with a GST treatment',
      'policy',
      { kind: 'other', title: 't', details: 'd' },
      'inclusive',
      null,
      null,
    ],
    ['a promotion without an end', 'promotion', promo, 'inclusive', null, null],
    ['a priced promotion without GST', 'promotion', promo, null, null, '2030-01-01T00:00:00Z'],
    [
      'an unpriced promotion with GST',
      'promotion',
      { title: 't', details: 'd' },
      'inclusive',
      null,
      '2030-01-01T00:00:00Z',
    ],
    [
      'a start after the end',
      'promotion',
      promo,
      'inclusive',
      '2030-02-01T00:00:00Z',
      '2030-01-01T00:00:00Z',
    ],
    ['an unknown type', 'service', { name: 'x' }, null, null, null],
  ])('the schema rejects %s', async (_name, type, value, gst, validFrom, validUntil) => {
    await expect(
      owner.query(
        `insert into facts (tenant_id, type, status, value, gst_treatment, valid_from, valid_until)
         values ($1, $2, 'approved', $3, $4, $5, $6)`,
        [TENANT_A, type, value, gst, validFrom, validUntil],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

// ---- FEAT-002: the audit chain tables and functions (ADR-014; AC-3, AC-9) -------------

const hex = (c: string) => c.repeat(64);

/** Appends one linked entry through the head lock, as `audit.append` does (any valid hash). */
async function appendRaw(c: pg.Client, tenantId: string, hash: string) {
  const head = (await c.query(`select seq, hash, ts from audit_head_lock()`)).rows[0];
  await c.query(
    `insert into audit_entries (tenant_id, seq, ts, actor_type, event_type, subject_refs, prev_hash, hash)
     values ($1, $2, $3, 'system', 'test.entry', '{test:1}', $4, $5)`,
    [tenantId, Number(head.seq) + 1, head.ts, head.hash, hash],
  );
}

/** Commits entries for a tenant as the dashboard role. */
async function commitEntries(tenantId: string, hashes: string[]) {
  const c = new pg.Client({ connectionString: tdb.urlFor('app_dashboard') });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    for (const h of hashes) await appendRaw(c, tenantId, h);
    await c.query(
      `insert into audit_pii (tenant_id, id, salt, data) values ($1, gen_random_uuid(), '\\x00', '{}')`,
      [tenantId],
    );
    await c.query('commit');
  } finally {
    await c.end();
  }
}

describe('audit chain', () => {
  beforeAll(async () => {
    await commitEntries(TENANT_A, [hex('a'), hex('b')]);
    await commitEntries(TENANT_B, [hex('c')]);
  });

  it('appends extend the head by one and link to it', async () => {
    const { rows } = await owner.query(
      `select tenant_id, seq::int, prev_hash, hash from audit_entries order by tenant_id, seq`,
    );
    const a = rows.filter((r) => r.tenant_id === TENANT_A);
    expect(a.map((r) => [r.seq, r.prev_hash, r.hash])).toEqual([
      [1, hex('0'), hex('a')],
      [2, hex('a'), hex('b')],
    ]);
    const heads = (await owner.query(`select tenant_id, seq::int, hash from audit_heads`)).rows;
    expect(heads).toEqual(
      expect.arrayContaining([
        { tenant_id: TENANT_A, seq: 2, hash: hex('b') },
        { tenant_id: TENANT_B, seq: 1, hash: hex('c') },
      ]),
    );
  });

  it.each([
    ['a wrong seq', 5, hex('b')],
    ['a wrong prev_hash', 3, hex('f')],
  ])('rejects a hand-written insert with %s', async (_name, seq, prev) => {
    await expect(
      asRole('app_dashboard', TENANT_A, (c) =>
        c.query(
          `insert into audit_entries (tenant_id, seq, ts, actor_type, event_type, subject_refs, prev_hash, hash)
           values ($1, $2, now(), 'system', 'forged', '{x:1}', $3, $4)`,
          [TENANT_A, seq, prev, hex('e')],
        ),
      ),
    ).rejects.toThrow(/does not extend the chain/);
  });

  it('rejects an insert with no chain head, even as the owner', async () => {
    const t = '00000000-0000-4000-8000-0000000000ff';
    await expect(
      owner.query(
        `insert into audit_entries (tenant_id, seq, ts, actor_type, event_type, subject_refs, prev_hash, hash)
         values ($1, 1, now(), 'system', 'forged', '{x:1}', $2, $3)`,
        [t, hex('0'), hex('e')],
      ),
    ).rejects.toThrow(/no chain head/);
  });

  it.each([
    ['update', `update audit_entries set event_type = 'x'`],
    ['delete', `delete from audit_entries`],
    ['truncate', `truncate audit_entries`],
  ])('the owner cannot %s entries', async (_op, q) => {
    await expect(owner.query(q)).rejects.toThrow(/append-only|permission denied/);
  });

  it.each(['app_dashboard', 'app_agent_visitor'] as const)(
    '%s cannot update, delete or truncate entries',
    async (role) => {
      for (const q of [
        `update audit_entries set event_type = 'x'`,
        `delete from audit_entries`,
        `truncate audit_entries`,
      ])
        await expect(asRole(role, TENANT_A, (c) => c.query(q))).rejects.toThrow(
          /permission denied/,
        );
    },
  );

  it("tenant B's context cannot read tenant A's entries or PII rows; no context reads nothing", async () => {
    const rows = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) =>
        (await c.query(`select tenant_id from audit_entries where tenant_id = $1`, [TENANT_A]))
          .rows,
    );
    expect(rows).toEqual([]);
    const pii = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) =>
        (await c.query(`select tenant_id from audit_pii where tenant_id = $1`, [TENANT_A])).rows,
    );
    expect(pii).toEqual([]);
    const own = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) => (await c.query(`select tenant_id from audit_entries`)).rows,
    );
    expect(own).toEqual([{ tenant_id: TENANT_B }]);
    const none = await asRole(
      'app_dashboard',
      null,
      async (c) => (await c.query(`select seq from audit_entries`)).rows,
    );
    expect(none).toEqual([]);
  });

  it("tenant B's context cannot append to tenant A's chain", async () => {
    await expect(
      asRole('app_dashboard', TENANT_B, (c) =>
        c.query(
          `insert into audit_entries (tenant_id, seq, ts, actor_type, event_type, subject_refs, prev_hash, hash)
           values ($1, 3, now(), 'system', 'forged', '{x:1}', $2, $3)`,
          [TENANT_A, hex('b'), hex('e')],
        ),
      ),
    ).rejects.toThrow(/no chain head|row-level security/);
  });

  it('the head lock fails closed without a tenant context', async () => {
    await expect(
      asRole('app_agent_visitor', null, (c) => c.query(`select * from audit_head_lock()`)),
    ).rejects.toThrow(/no tenant context/);
  });

  it('the visitor role appends but cannot read entries or PII rows', async () => {
    await asRole('app_agent_visitor', TENANT_A, (c) => appendRaw(c, TENANT_A, hex('d')));
    for (const q of [`select * from audit_entries`, `select * from audit_pii`])
      await expect(asRole('app_agent_visitor', TENANT_A, (c) => c.query(q))).rejects.toThrow(
        /permission denied/,
      );
  });

  it.each(['app_dashboard', 'app_agent_visitor', 'app_outbox'] as const)(
    '%s has no direct access to audit_heads',
    async (role) => {
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`select * from audit_heads`)),
      ).rejects.toThrow(/permission denied/);
      // FEAT-002 acceptance: "read or write" covers insert and delete too (AC-3).
      for (const q of [
        `update audit_heads set seq = 0`,
        `insert into audit_heads (tenant_id, seq, hash) values ('${TENANT_A}', 0, repeat('0', 64))`,
        `delete from audit_heads`,
      ])
        await expect(asRole(role, TENANT_A, (c) => c.query(q))).rejects.toThrow(
          /permission denied/,
        );
    },
  );

  it('the outbox role sees moved heads across tenants and records anchors, nothing else', async () => {
    const heads = await asRole(
      'app_outbox',
      null,
      async (c) => (await c.query(`select tenant_id, seq::int from audit_heads_to_anchor()`)).rows,
    );
    expect(heads).toEqual(
      expect.arrayContaining([
        { tenant_id: TENANT_A, seq: 2 },
        { tenant_id: TENANT_B, seq: 1 },
      ]),
    );
    const c = new pg.Client({ connectionString: tdb.urlFor('app_outbox') });
    await c.connect();
    await c.query(`select audit_mark_anchored($1, 2)`, [TENANT_A]);
    const after = (await c.query(`select tenant_id from audit_heads_to_anchor()`)).rows;
    await c.end();
    expect(after).toEqual([{ tenant_id: TENANT_B }]);
    for (const q of [`select * from audit_entries`, `select * from audit_pii`])
      await expect(asRole('app_outbox', null, (cc) => cc.query(q))).rejects.toThrow(
        /permission denied/,
      );
    await expect(
      asRole('app_dashboard', TENANT_A, (cc) => cc.query(`select * from audit_heads_to_anchor()`)),
    ).rejects.toThrow(/permission denied/);
  });
});

// ---- FEAT-005: identity tables and the identity zone (ADR-005, ADR-020; AC-14) --------

describe('identity zone', () => {
  it('the person tables are RLS-forced with a policy for the identity zone only', async () => {
    const { rows } = await owner.query<{ table: string; forced: boolean; roles: string[] }>(`
      select c.relname as table, c.relforcerowsecurity as forced,
             (select array_agg(distinct r::text) from pg_policies p, unnest(p.roles) r
               where p.schemaname = 'public' and p.tablename = c.relname) as roles
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('users', 'sessions', 'magic_links')
      order by 1`);
    expect(rows).toEqual([
      { table: 'magic_links', forced: true, roles: ['app_identity'] },
      { table: 'sessions', forced: true, roles: ['app_identity'] },
      { table: 'users', forced: true, roles: ['app_identity'] },
    ]);
  });

  it.each(['app_dashboard', 'app_agent_visitor', 'app_outbox'] as const)(
    '%s cannot read users, sessions or magic links',
    async (role) => {
      for (const table of ['users', 'sessions', 'magic_links']) {
        await expect(
          asRole(role, TENANT_A, (c) => c.query(`select * from ${table}`)),
          `${role} on ${table}`,
        ).rejects.toThrow(/permission denied/);
      }
    },
  );

  it.each([
    'conversations',
    'messages',
    'facts',
    'kb_chunks',
    'audit_entries',
    'audit_pii',
    'outbox',
  ])('the identity zone cannot read %s', async (table) => {
    await expect(
      asRole('app_identity', TENANT_A, (c) => c.query(`select * from ${table}`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("reads a user's memberships across tenants, but writes only in the current tenant", async () => {
    const bakeryOwner = (
      await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)
    ).rows[0].id;
    const rows = await asRole(
      'app_identity',
      null,
      async (c) =>
        (await c.query(`select tenant_id, role from memberships where user_id = $1`, [bakeryOwner]))
          .rows,
    );
    expect(rows).toEqual([{ tenant_id: TENANT_A, role: 'owner' }]);
    await expect(
      asRole('app_identity', TENANT_B, (c) =>
        c.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')`, [
          TENANT_A,
          bakeryOwner,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the identity zone sees only the current tenant row and cannot create another tenant', async () => {
    const rows = await asRole(
      'app_identity',
      TENANT_B,
      async (c) => (await c.query(`select id from tenants`)).rows,
    );
    expect(rows).toEqual([{ id: TENANT_B }]);
    await expect(
      asRole('app_identity', TENANT_B, (c) =>
        c.query(
          `insert into tenants (id, slug, name, widget_key) values (gen_random_uuid(), 'x', 'X', 'wk_x')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('memberships and terms acceptances are isolated for the dashboard zone', async () => {
    const m = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) => (await c.query(`select tenant_id from memberships`)).rows,
    );
    expect(m).toEqual([{ tenant_id: TENANT_B }]);
    const t = await asRole(
      'app_dashboard',
      TENANT_B,
      async (c) =>
        (await c.query(`select tenant_id from terms_acceptances where tenant_id = $1`, [TENANT_A]))
          .rows,
    );
    expect(t).toEqual([]);
  });

  it('terms acceptances are insert-only', async () => {
    for (const role of ['app_dashboard', 'app_identity'] as const) {
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`update terms_acceptances set version = 'x'`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`delete from terms_acceptances`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

// ---- FEAT-004: the usage ledger and the cost governor (ADR-021, ADR-007; AC-4, AC-6) ---

describe('usage ledger', () => {
  const insertEvent = (c: pg.Client, tenantId: string) =>
    c.query(
      `insert into usage_events (tenant_id, purpose, model, provider, provider_model_id, cost_usd)
       values ($1, 'reply', 'reply.simple', 'fake', 'fake-haiku', 0.001)`,
      [tenantId],
    );

  beforeAll(async () => {
    for (const t of [TENANT_A, TENANT_B]) await insertEvent(owner, t);
  });

  it('the visitor and dashboard zones insert in their own tenant only, and read nothing', async () => {
    for (const role of ['app_agent_visitor', 'app_dashboard'] as const) {
      await asRole(role, TENANT_B, (c) => insertEvent(c, TENANT_B));
      await expect(asRole(role, TENANT_B, (c) => insertEvent(c, TENANT_A))).rejects.toThrow(
        /row-level security/,
      );
      await expect(
        asRole(role, TENANT_B, (c) => c.query(`select * from usage_events`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('no zone can update or delete a ledger row', async () => {
    for (const role of ['app_agent_visitor', 'app_dashboard', 'app_outbox'] as const) {
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`update usage_events set cost_usd = 0`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`delete from usage_events`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('only the outbox zone may run the governor, and it reads nothing else', async () => {
    const rows = await asRole(
      'app_outbox',
      null,
      async (c) => (await c.query(`select * from cost_governor_evaluate(0, 0, 1)`)).rows,
    );
    expect(rows).toEqual([]);
    await expect(
      asRole('app_outbox', null, (c) => c.query(`select * from usage_events`)),
    ).rejects.toThrow(/permission denied/);
    for (const role of ['app_agent_visitor', 'app_dashboard', 'app_identity'] as const)
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`select * from cost_governor_evaluate(0, 0, 1)`)),
      ).rejects.toThrow(/permission denied/);
  });
});
