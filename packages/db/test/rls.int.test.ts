/**
 * Cross-tenant RLS suite (GOV-03, ADR-005; plan §2 done-when 2). Every tenant-scoped
 * table must have forced RLS, a policy, and an entry in TENANT_SCOPED_TABLES; tenant
 * B's context can never read or write tenant A's rows, even with hand-written SQL.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_SCOPED_TABLES } from '../src/schema.js';
import { BAKERY_HOURS } from '../src/setup.js';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '../src/testing.js';

let tdb: TestDatabase;
let owner: pg.Client;

async function asRole<T>(
  role: 'app_dashboard' | 'app_agent_visitor' | 'app_outbox' | 'app_identity' | 'app_ingest',
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
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_dashboard','app_agent_visitor','app_outbox','app_identity','app_ingest')`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      `select tablename from pg_tables where schemaname = 'public' and tableowner in ('app_dashboard','app_agent_visitor','app_outbox','app_identity','app_ingest')`,
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
        hours: BAKERY_HOURS,
        open_on_public_holidays: false,
        // FEAT-024: no saved assistant settings, so the defaults.
        bot_name: null,
        tone: 'friendly',
        emoji: false,
        greeting_en: null,
        greeting_zh: null,
        disclosure_note_en: null,
        disclosure_note_zh: null,
        after_hours_en: null,
        after_hours_zh: null,
        fallback_en: null,
        fallback_zh: null,
        holidays: {},
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

// ---- FEAT-023: opening hours and message notices (FEAT-023 §4; AC-10) ---------------

describe('opening hours and message notices (FEAT-023)', () => {
  const HOURS = { mon: [{ open: '08:00', close: '19:00' }], sun: [] };

  it("visitor_tenant_state returns the current tenant's hours only", async () => {
    await owner.query(
      `update business_profiles set hours = $2, open_on_public_holidays = true where tenant_id = $1`,
      [TENANT_B, HOURS],
    );
    try {
      const b = await asRole(
        'app_agent_visitor',
        TENANT_B,
        async (c) =>
          (await c.query(`select hours, open_on_public_holidays from visitor_tenant_state()`)).rows,
      );
      expect(b).toEqual([{ hours: HOURS, open_on_public_holidays: true }]);
      const a = await asRole(
        'app_agent_visitor',
        TENANT_A,
        async (c) =>
          (await c.query(`select hours, open_on_public_holidays from visitor_tenant_state()`)).rows,
      );
      expect(a[0].hours).not.toEqual(HOURS);
    } finally {
      await owner.query(
        `update business_profiles set hours = null, open_on_public_holidays = false where tenant_id = $1`,
        [TENANT_B],
      );
    }
  });

  it('the visitor role still cannot read business_profiles directly', async () => {
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select hours from business_profiles`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects hours that are not an object', async () => {
    await expect(
      owner.query(`update business_profiles set hours = '[]' where tenant_id = $1`, [TENANT_A]),
    ).rejects.toThrow(/business_profiles_hours_ck/);
  });

  it('a notice needs a known kind, and a kind needs a notice', async () => {
    const insert = (notice: string | null, kind: string | null) =>
      asRole('app_agent_visitor', TENANT_A, async (c) => {
        const conv = (await c.query(`select id from conversations limit 1`)).rows[0].id;
        return c.query(
          `insert into messages (tenant_id, conversation_id, author, body, notice, notice_kind)
           values ($1, $2, 'agent', 'hi', $3, $4)`,
          [TENANT_A, conv, notice, kind],
        );
      });
    await expect(insert('We are closed', null)).rejects.toThrow(/messages_notice_ck/);
    await expect(insert(null, 'after_hours')).rejects.toThrow(/messages_notice_ck/);
    await expect(insert('We are closed', 'rate_limited')).rejects.toThrow(/messages_notice_ck/);
    await expect(insert('We are closed', 'after_hours')).resolves.toBeTruthy();
  });

  it("tenant B cannot see tenant A's notices", async () => {
    const convA = (
      await owner.query(`select id from conversations where tenant_id = $1 limit 1`, [TENANT_A])
    ).rows[0].id;
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, notice, notice_kind)
       values ($1, $2, 'agent', 'hi', 'closed notice of A', 'after_hours')`,
      [TENANT_A, convA],
    );
    for (const role of ['app_agent_visitor', 'app_dashboard'] as const) {
      const seen = await asRole(
        role,
        TENANT_B,
        async (c) => (await c.query(`select notice from messages where notice is not null`)).rows,
      );
      expect(seen).toEqual([]);
    }
  });
});

// ---- FEAT-025: flagged conversations and the chat-ended notice (FEAT-025 §4; AC-10) ----

describe('flagged conversations and chat-ended notices (FEAT-025)', () => {
  const convOf = async (tenant: string) =>
    (await owner.query(`select id from conversations where tenant_id = $1 limit 1`, [tenant]))
      .rows[0].id as string;

  it('the visitor role flags and counts abuse on its own tenant only', async () => {
    const convA = await convOf(TENANT_A);
    const updated = await asRole('app_agent_visitor', TENANT_A, async (c) => {
      const r = await c.query(
        `update conversations
         set flagged_at = now(), flag_reasons = array['abuse'],
             abuse_turns = array[gen_random_uuid()], status = 'closed'
         where id = $1 returning flag_reasons, cardinality(abuse_turns) as n`,
        [convA],
      );
      return r.rows;
    });
    expect(updated).toEqual([{ flag_reasons: ['abuse'], n: 1 }]);
    const fromB = await asRole('app_agent_visitor', TENANT_B, async (c) => {
      const r = await c.query(
        `update conversations set flagged_at = now(), flag_reasons = array['crisis'] where id = $1`,
        [convA],
      );
      return r.rowCount;
    });
    expect(fromB).toBe(0);
  });

  it('the visitor role still cannot change visitor_id or channel', async () => {
    const convA = await convOf(TENANT_A);
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) =>
        c.query(`update conversations set visitor_id = gen_random_uuid() where id = $1`, [convA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) =>
        c.query(`update conversations set channel = 'widget' where id = $1`, [convA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a flag needs a known reason and a time, and a time needs a reason', async () => {
    const convA = await convOf(TENANT_A);
    const set = (at: string | null, reasons: string[]) =>
      owner.query(
        `update conversations set flagged_at = $2::timestamptz, flag_reasons = $3::text[] where id = $1`,
        [convA, at, reasons],
      );
    const at = new Date().toISOString();
    try {
      await expect(set(at, ['spam'])).rejects.toThrow(/conversations_flag_ck/);
      await expect(set(null, ['abuse'])).rejects.toThrow(/conversations_flag_ck/);
      await expect(set(at, [])).rejects.toThrow(/conversations_flag_ck/);
      await expect(set(at, ['crisis', 'abuse'])).resolves.toBeTruthy();
    } finally {
      await set(null, []);
    }
  });

  it('the notice check accepts chat_ended and still rejects unknown kinds', async () => {
    const insert = (kind: string) =>
      asRole('app_agent_visitor', TENANT_A, async (c) => {
        const conv = (await c.query(`select id from conversations limit 1`)).rows[0].id;
        return c.query(
          `insert into messages (tenant_id, conversation_id, author, body, notice, notice_kind)
           values ($1, $2, 'agent', 'bye', 'This chat has ended.', $3)`,
          [TENANT_A, conv, kind],
        );
      });
    await expect(insert('chat_ended')).resolves.toBeTruthy();
    await expect(insert('banned')).rejects.toThrow(/messages_notice_ck/);
  });

  it("tenant B cannot see tenant A's flags", async () => {
    const convA = await convOf(TENANT_A);
    await owner.query(
      `update conversations set flagged_at = now(), flag_reasons = array['crisis'] where id = $1`,
      [convA],
    );
    try {
      for (const role of ['app_agent_visitor', 'app_dashboard'] as const) {
        const seen = await asRole(
          role,
          TENANT_B,
          async (c) =>
            (await c.query(`select id from conversations where flagged_at is not null`)).rows,
        );
        expect(seen).toEqual([]);
      }
    } finally {
      await owner.query(
        `update conversations set flagged_at = null, flag_reasons = '{}' where id = $1`,
        [convA],
      );
    }
  });
});

// ---- FEAT-024: assistant settings (FEAT-024 §4; AC-2, AC-10) ---------------------------

describe('assistant settings (FEAT-024)', () => {
  const PERSONA = `select bot_name, tone, emoji, greeting_en, disclosure_note_zh, fallback_en
                   from visitor_tenant_state()`;

  it('visitor_tenant_state returns defaults without a row', async () => {
    const rows = await asRole(
      'app_agent_visitor',
      TENANT_A,
      async (c) => (await c.query(PERSONA)).rows,
    );
    expect(rows).toEqual([
      {
        bot_name: null,
        tone: 'friendly',
        emoji: false,
        greeting_en: null,
        disclosure_note_zh: null,
        fallback_en: null,
      },
    ]);
  });

  it("the dashboard writes its own tenant's row; the function returns that tenant's only", async () => {
    await asRole('app_dashboard', TENANT_B, async (c) => {
      await c.query(
        `insert into assistant_settings (tenant_id, bot_name, tone, emoji, fallback_en)
         values ($1, 'Mei', 'professional', true, 'We will reply soon.')`,
        [TENANT_B],
      );
      await c.query(`update assistant_settings set disclosure_note_zh = '我们会阅读每条消息。'`);
      expect((await c.query(`select bot_name from assistant_settings`)).rows).toEqual([
        { bot_name: 'Mei' },
      ]);
    });
    await owner.query(
      `insert into assistant_settings (tenant_id, bot_name, emoji) values ($1, 'Kaki', true)`,
      [TENANT_B],
    );
    try {
      const b = await asRole(
        'app_agent_visitor',
        TENANT_B,
        async (c) => (await c.query(PERSONA)).rows,
      );
      expect(b[0]).toMatchObject({ bot_name: 'Kaki', emoji: true, tone: 'friendly' });
      const a = await asRole(
        'app_agent_visitor',
        TENANT_A,
        async (c) => (await c.query(PERSONA)).rows,
      );
      expect(a[0].bot_name).toBeNull();
    } finally {
      await owner.query(`delete from assistant_settings where tenant_id = $1`, [TENANT_B]);
    }
  });

  it("tenant B can't read or write tenant A's row", async () => {
    await owner.query(
      `insert into assistant_settings (tenant_id, bot_name) values ($1, 'Ah Boy')`,
      [TENANT_A],
    );
    try {
      await asRole('app_dashboard', TENANT_B, async (c) => {
        expect((await c.query(`select * from assistant_settings`)).rows).toEqual([]);
        const upd = await c.query(`update assistant_settings set bot_name = 'Hacked'`);
        expect(upd.rowCount).toBe(0);
        await expect(
          c.query(`insert into assistant_settings (tenant_id) values ($1)`, [TENANT_A]),
        ).rejects.toThrow(/row-level security/);
      });
    } finally {
      await owner.query(`delete from assistant_settings where tenant_id = $1`, [TENANT_A]);
    }
  });

  it('the visitor role cannot read assistant_settings directly', async () => {
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from assistant_settings`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('the checks reject digits in the name, blank texts, long texts and unknown tones', async () => {
    const ins = (cols: string, vals: unknown[]) =>
      owner.query(
        `insert into assistant_settings (tenant_id, ${cols}) values ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})`,
        [TENANT_A, ...vals],
      );
    await expect(ins('bot_name', ['Kaki 2'])).rejects.toThrow(/assistant_settings_bot_name_ck/);
    await expect(ins('bot_name', [' Kaki'])).rejects.toThrow(/assistant_settings_bot_name_ck/);
    await expect(ins('bot_name', ['x'.repeat(31)])).rejects.toThrow(
      /assistant_settings_bot_name_ck/,
    );
    await expect(ins('greeting_en', ['  '])).rejects.toThrow(/assistant_settings_texts_ck/);
    await expect(ins('fallback_zh', ['好'.repeat(301)])).rejects.toThrow(
      /assistant_settings_texts_ck/,
    );
    await expect(ins('tone', ['sassy'])).rejects.toThrow(/assistant_settings_tone_ck/);
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

// ---- FEAT-009: business profile and holiday exceptions (FEAT-009 §4; AC-2, AC-9) ------

describe('business profile and holidays (FEAT-009)', () => {
  /** A Singapore day `offset` days from today, `YYYY-MM-DD`. */
  const sgDay = (offset: number) =>
    new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const HOLIDAYS = `select holidays from visitor_tenant_state()`;

  it("the dashboard edits its own tenant's profile, name and holidays only", async () => {
    const { rows: before } = await owner.query(`select name from tenants where id = $1`, [
      TENANT_B,
    ]);
    try {
      await asRole('app_dashboard', TENANT_B, async (c) => {
        await c.query(
          `update business_profiles set uen = '201912345K', industry = 'fnb', contact_phone = '+6591234567',
                  languages = '{en,zh}', version = version + 1`,
        );
        await c.query(`update tenants set name = 'Renamed'`);
        await c.query(
          `insert into holidays (tenant_id, day, kind, label) values ($1, $2, 'closed', 'Staff day')`,
          [TENANT_B, sgDay(1)],
        );
        expect((await c.query(`select day::text, kind from holidays`)).rows).toEqual([
          { day: sgDay(1), kind: 'closed' },
        ]);
      });
      // Each refused statement in its own transaction (a failed one aborts the rest).
      for (const stmt of [
        `update tenants set ai_paused = true`,
        `update tenants set widget_key = 'x'`,
        `update business_profiles set tenant_id = tenant_id`,
      ])
        await expect(asRole('app_dashboard', TENANT_B, (c) => c.query(stmt))).rejects.toThrow(
          /permission denied/,
        );
      await owner.query(`insert into holidays (tenant_id, day, kind) values ($1, $2, 'closed')`, [
        TENANT_B,
        sgDay(1),
      ]);
      const b = await asRole(
        'app_agent_visitor',
        TENANT_B,
        async (c) => (await c.query(HOLIDAYS)).rows,
      );
      expect(b).toEqual([{ holidays: { [sgDay(1)]: 'closed' } }]);
      const a = await asRole(
        'app_agent_visitor',
        TENANT_A,
        async (c) => (await c.query(HOLIDAYS)).rows,
      );
      expect(a).toEqual([{ holidays: {} }]);
    } finally {
      await owner.query(`delete from holidays where tenant_id = $1`, [TENANT_B]);
      await owner.query(`update tenants set name = $2 where id = $1`, [TENANT_B, before[0].name]);
      await owner.query(
        `update business_profiles set uen = null, industry = null, contact_phone = null, languages = '{en}' where tenant_id = $1`,
        [TENANT_B],
      );
    }
  });

  it("tenant B can't read or write tenant A's holidays", async () => {
    await owner.query(`insert into holidays (tenant_id, day, kind) values ($1, $2, 'closed')`, [
      TENANT_A,
      sgDay(2),
    ]);
    try {
      await asRole('app_dashboard', TENANT_B, async (c) => {
        expect((await c.query(`select * from holidays`)).rows).toEqual([]);
        expect((await c.query(`delete from holidays`)).rowCount).toBe(0);
        expect(
          (await c.query(`update tenants set name = 'Hacked' where id = $1`, [TENANT_A])).rowCount,
        ).toBe(0);
        await expect(
          c.query(`insert into holidays (tenant_id, day, kind) values ($1, $2, 'open')`, [
            TENANT_A,
            sgDay(3),
          ]),
        ).rejects.toThrow(/row-level security/);
      });
    } finally {
      await owner.query(`delete from holidays where tenant_id = $1`, [TENANT_A]);
    }
  });

  it('visitor_tenant_state returns exceptions within 15 days only; the visitor role cannot read holidays', async () => {
    await owner.query(
      `insert into holidays (tenant_id, day, kind) values ($1, $2, 'closed'), ($1, $3, 'open'), ($1, $4, 'closed')`,
      [TENANT_A, sgDay(-20), sgDay(-15), sgDay(16)],
    );
    try {
      const rows = await asRole(
        'app_agent_visitor',
        TENANT_A,
        async (c) => (await c.query(HOLIDAYS)).rows,
      );
      expect(rows).toEqual([{ holidays: { [sgDay(-15)]: 'open' } }]);
      await expect(
        asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from holidays`)),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query(`delete from holidays where tenant_id = $1`, [TENANT_A]);
    }
  });

  it('the checks reject bad UENs, phones, emails, industries, languages, kinds and labels', async () => {
    const upd = (set: string, v: unknown) =>
      owner.query(`update business_profiles set ${set} = $2 where tenant_id = $1`, [TENANT_A, v]);
    for (const uen of ['2019123K', '201912345', 'X08LL1234A', 's99ab1234z', '2019-12345K'])
      await expect(upd('uen', uen)).rejects.toThrow(/business_profiles_uen_ck/);
    for (const phone of ['91234567', '+6571234567', '+659123456'])
      await expect(upd('contact_phone', phone)).rejects.toThrow(/business_profiles_phone_ck/);
    await expect(upd('contact_email', 'no-at-sign')).rejects.toThrow(/business_profiles_email_ck/);
    await expect(upd('industry', 'mining')).rejects.toThrow(/business_profiles_industry_ck/);
    await expect(upd('languages', '{}')).rejects.toThrow(/business_profiles_languages_ck/);
    await expect(upd('languages', '{en,fr}')).rejects.toThrow(/business_profiles_languages_ck/);
    for (const [uen, phone] of [
      ['53312345A', '+6561234567'],
      ['201912345K', '+6591234567'],
      ['T08LL1234A', '+6581234567'],
    ]) {
      await upd('uen', uen);
      await upd('contact_phone', phone);
    }
    await owner.query(
      `update business_profiles set uen = null, contact_phone = null where tenant_id = $1`,
      [TENANT_A],
    );
    const ins = (kind: string, label: string | null) =>
      owner.query(`insert into holidays (tenant_id, day, kind, label) values ($1, $2, $3, $4)`, [
        TENANT_A,
        sgDay(5),
        kind,
        label,
      ]);
    await expect(ins('half', null)).rejects.toThrow(/holidays_kind_ck/);
    await expect(ins('closed', '  ')).rejects.toThrow(/holidays_label_ck/);
    await expect(ins('closed', 'x'.repeat(61))).rejects.toThrow(/holidays_label_ck/);
  });
});

describe('knowledge sources, pages and staged facts (FEAT-012)', () => {
  /** A source with one page and one staged fact for `tenant`, as the owner. */
  async function seedSource(tenant: string, domain: string) {
    const src = await owner.query<{ id: string }>(
      `insert into kb_sources (tenant_id, kind, name, url, domain, page_limit, attested_by, attested_at, created_by)
       values ($1, 'website', $3, $2, $3, 100, 'u', now(), 'u') returning id`,
      [tenant, `https://${domain}/`, domain],
    );
    const page = await owner.query<{ id: string }>(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
       values ($1, $2, 1, 0, $3, 'included', 'Fudge cake S$55') returning id`,
      [tenant, src.rows[0]!.id, `https://${domain}/`],
    );
    await owner.query(
      `insert into kb_staged_facts (tenant_id, source_id, attempt, page_id, type, value, gst_treatment,
         quote, quote_start, quote_end, confidence, dedupe_key)
       values ($1, $2, 1, $3, 'product', '{"name":"Fudge cake","priceCents":5500,"currency":"SGD"}',
         'unknown', 'Fudge cake S$55', 0, 15, 0.9, 'product:fudge cake')`,
      [tenant, src.rows[0]!.id, page.rows[0]!.id],
    );
    return src.rows[0]!.id;
  }
  async function cleanup() {
    for (const t of ['kb_staged_facts', 'kb_source_pages'])
      await owner.query(`delete from ${t} where tenant_id in ($1, $2)`, [TENANT_A, TENANT_B]);
    await owner.query(`delete from facts where source_id is not null`);
    await owner.query(`delete from kb_sources where tenant_id in ($1, $2)`, [TENANT_A, TENANT_B]);
  }

  it.each(['app_dashboard', 'app_ingest'] as const)(
    "as %s, tenant B can't read or change tenant A's sources, pages or staged facts",
    async (role) => {
      const a = await seedSource(TENANT_A, 'a.example');
      await seedSource(TENANT_B, 'b.example');
      try {
        await asRole(role, TENANT_B, async (c) => {
          for (const t of ['kb_sources', 'kb_source_pages', 'kb_staged_facts']) {
            const rows = (await c.query(`select tenant_id from ${t}`)).rows;
            expect(rows.length, t).toBe(1);
            expect(
              rows.every((r) => r.tenant_id === TENANT_B),
              t,
            ).toBe(true);
          }
          expect(
            (await c.query(`update kb_sources set status = 'ready' where id = $1`, [a])).rowCount,
          ).toBe(0);
          expect(
            (await c.query(`delete from kb_staged_facts where source_id = $1`, [a])).rowCount,
          ).toBe(0);
          // Each role's own insert: the dashboard adds sources, the worker adds pages.
          const insert =
            role === 'app_dashboard'
              ? c.query(
                  `insert into kb_sources (tenant_id, kind, name, url, domain, page_limit, attested_by, attested_at, created_by)
                   values ($1, 'website', 'c.example', 'https://c.example/', 'c.example', 100, 'u', now(), 'u')`,
                  [TENANT_A],
                )
              : c.query(
                  `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status)
                   values ($1, $2, 1, 1, 'https://a.example/x', 'included')`,
                  [TENANT_A, a],
                );
          await expect(insert).rejects.toThrow(/row-level security/);
        });
      } finally {
        await cleanup();
      }
    },
  );

  it('the ingest role writes extracted facts but cannot delete them or read conversations, identity or other tenants', async () => {
    const src = await seedSource(TENANT_B, 'b.example');
    try {
      await asRole('app_ingest', TENANT_B, async (c) => {
        const f = await c.query<{ id: string }>(
          `insert into facts (tenant_id, type, status, value, gst_treatment, source, source_id, confidence, provenance)
           values ($1, 'product', 'needs_review', '{"name":"Fudge cake","priceCents":5500,"currency":"SGD"}',
             'unknown', 'website', $2, 0.9, '{"url":"https://b.example/","quote":"Fudge cake S$55","start":0,"end":15}')
           returning id`,
          [TENANT_B, src],
        );
        expect(f.rows).toHaveLength(1);
        // Provenance is required on an extracted fact.
        await c.query('savepoint s');
        await expect(
          c.query(
            `insert into facts (tenant_id, type, status, value, gst_treatment, source_id)
             values ($1, 'faq', 'needs_review', '{"question":"q","answer":"a"}', null, $2)`,
            [TENANT_B, src],
          ),
        ).rejects.toThrow(/facts_provenance_ck/);
        await c.query('rollback to savepoint s');
      });
      for (const stmt of [
        `delete from facts`,
        // FEAT-014 D8: it may move a fact's status and version (conflicts), nothing else.
        `update facts set value = '{}'`,
        `update facts set gst_treatment = 'inclusive'`,
        `update facts set provenance = null`,
        `update kb_chunks set content = 'x'`,
        `select * from conversations`,
        `select * from messages`,
        `select * from users`,
        `select * from sessions`,
        `select * from memberships`,
        `delete from kb_sources`,
        `insert into kb_sources (tenant_id, kind, name, url, domain, page_limit, attested_by, attested_at, created_by)
           values ('${TENANT_B}', 'website', 'x.example', 'https://x.example/', 'x.example', 100, 'u', now(), 'u')`,
      ])
        await expect(
          asRole('app_ingest', TENANT_B, (c) => c.query(stmt)),
          stmt,
        ).rejects.toThrow(/permission denied/);
    } finally {
      await cleanup();
    }
  });

  it('the ingest role moves facts to conflicted in its own tenant only (FEAT-014 D8)', async () => {
    const insert = (tenant: string) =>
      owner.query<{ id: string }>(
        `insert into facts (tenant_id, type, status, value, gst_treatment)
         values ($1, 'product', 'approved', '{"name":"Pandan chiffon cake","priceCents":2600,"currency":"SGD","unit":"20 cm"}',
           'inclusive') returning id`,
        [tenant],
      );
    const a = (await insert(TENANT_A)).rows[0]!.id;
    const b = (await insert(TENANT_B)).rows[0]!.id;
    await owner.query(
      `insert into kb_chunks (tenant_id, fact_id, fact_version, content, embedding)
       select tenant_id, id, 1, 'c', array_fill(0.1, array[1024])::vector from facts where id in ($1, $2)`,
      [a, b],
    );
    try {
      await asRole('app_ingest', TENANT_B, async (c) => {
        const moved = await c.query(
          `update facts set status = 'conflicted', version = version + 1, updated_by = 'ingest-worker',
             updated_at = now() where id in ($1, $2) returning id`,
          [a, b],
        );
        expect(moved.rows.map((r) => r.id)).toEqual([b]);
        expect(
          (await c.query(`update kb_chunks set fact_version = 2 where fact_id in ($1, $2)`, [a, b]))
            .rowCount,
        ).toBe(1);
      });
    } finally {
      await owner.query(`delete from kb_chunks where fact_id in ($1, $2)`, [a, b]);
      await owner.query(`delete from facts where id in ($1, $2)`, [a, b]);
    }
  });

  it('the visitor role cannot read sources, pages or staged facts; staged and needs_review facts never reach visitor_facts', async () => {
    const src = await seedSource(TENANT_A, 'a.example');
    try {
      await owner.query(
        `insert into facts (tenant_id, type, status, value, gst_treatment, source, source_id, confidence, provenance)
         values ($1, 'product', 'needs_review', '{"name":"Extracted cake","priceCents":4200,"currency":"SGD"}',
           'inclusive', 'website', $2, 0.9, '{"url":"https://a.example/","quote":"q","start":0,"end":1}')`,
        [TENANT_A, src],
      );
      for (const t of ['kb_sources', 'kb_source_pages', 'kb_staged_facts'])
        await expect(
          asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from ${t}`)),
        ).rejects.toThrow(/permission denied/);
      const visible = await asRole('app_agent_visitor', TENANT_A, async (c) =>
        (await c.query(`select value->>'name' as name from visitor_facts`)).rows.map((r) => r.name),
      );
      expect(visible).not.toContain('Extracted cake');
    } finally {
      await cleanup();
    }
  });

  it("file sources (FEAT-015): tenant B can't see or change tenant A's, and the kind's checks hold", async () => {
    const file = (tenant: string, key: string) =>
      owner.query<{ id: string }>(
        `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, created_by)
         values ($1, 'file', 'menu.pdf', $2, 1024, 'u') returning id`,
        [tenant, key],
      );
    const a = (await file(TENANT_A, `uploads/${TENANT_A}/1`)).rows[0]!.id;
    await file(TENANT_B, `uploads/${TENANT_B}/1`);
    try {
      for (const role of ['app_dashboard', 'app_ingest'] as const)
        await asRole(role, TENANT_B, async (c) => {
          const rows = (await c.query(`select tenant_id from kb_sources where kind = 'file'`)).rows;
          expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
          expect(
            (await c.query(`update kb_sources set file_key = 'x' where id = $1`, [a])).rowCount,
          ).toBe(0);
        });
      // A file needs its upload key and size; a website still needs its URL and attestation.
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, created_by) values ($1, 'file', 'x.pdf', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_file_ck/);
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, created_by) values ($1, 'website', 'x.sg', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_website_ck/);
      await expect(file(TENANT_A, `uploads/${TENANT_A}/1`)).rejects.toThrow(/kb_sources_upload_uq/);
    } finally {
      await cleanup();
    }
  });

  it("spreadsheet sources (FEAT-016): tenant B can't see tenant A's or their rows, and the kind's checks hold", async () => {
    const sheet = (tenant: string, key: string) =>
      owner.query<{ id: string }>(
        `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, file_type, stage, created_by)
         values ($1, 'spreadsheet', 'prices.xlsx', $2, 2048, 'xlsx', 'map', 'u') returning id`,
        [tenant, key],
      );
    const a = (await sheet(TENANT_A, `uploads/${TENANT_A}/s1`)).rows[0]!.id;
    await sheet(TENANT_B, `uploads/${TENANT_B}/s1`);
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content, cells)
       values ($1, $2, 1, 0, 'row/2', 'included', 'Cake | 12', '{Cake,12}')`,
      [TENANT_A, a],
    );
    try {
      for (const role of ['app_dashboard', 'app_ingest'] as const)
        await asRole(role, TENANT_B, async (c) => {
          const rows = (
            await c.query(`select tenant_id from kb_sources where kind = 'spreadsheet'`)
          ).rows;
          expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
          expect(
            (await c.query(`select * from kb_source_pages where source_id = $1`, [a])).rows,
          ).toEqual([]);
          expect(
            (await c.query(`update kb_sources set mapping = '{}' where id = $1`, [a])).rowCount,
          ).toBe(0);
        });
      // A spreadsheet needs its upload; its type is a sheet's, and only it holds a mapping.
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, created_by) values ($1, 'spreadsheet', 'x.csv', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_file_ck/);
      await expect(
        owner.query(`update kb_sources set file_type = 'pdf' where id = $1`, [a]),
      ).rejects.toThrow(/kb_sources_sheet_type_ck/);
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, file_type, created_by)
           values ($1, 'file', 'x.xlsx', 'k', 1, 'xlsx', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_sheet_type_ck/);
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, mapping, created_by)
           values ($1, 'file', 'x.pdf', 'k2', 1, '{}', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_mapping_ck/);
    } finally {
      await owner.query(`delete from kb_source_pages where source_id = $1`, [a]);
      await cleanup();
    }
  });

  it("chat sources (FEAT-017): tenant B can't see tenant A's or their parts, and the kind's checks hold", async () => {
    const chat = (tenant: string, key: string) =>
      owner.query<{ id: string }>(
        `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, file_type, chat, stage, created_by)
         values ($1, 'chat', 'Chat export', $2, 2048, 'txt', '{"businessNames":["Kaki"]}', 'extract', 'u') returning id`,
        [tenant, key],
      );
    const a = (await chat(TENANT_A, `uploads/${TENANT_A}/c1`)).rows[0]!.id;
    await chat(TENANT_B, `uploads/${TENANT_B}/c1`);
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
       values ($1, $2, 1, 0, 'chat/1', 'included', 'Customer: Open on Sunday?')`,
      [TENANT_A, a],
    );
    try {
      for (const role of ['app_dashboard', 'app_ingest'] as const)
        await asRole(role, TENANT_B, async (c) => {
          const rows = (await c.query(`select tenant_id from kb_sources where kind = 'chat'`)).rows;
          expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
          expect(
            (await c.query(`select * from kb_source_pages where source_id = $1`, [a])).rows,
          ).toEqual([]);
          expect(
            (await c.query(`update kb_sources set chat = '{}' where id = $1`, [a])).rowCount,
          ).toBe(0);
        });
      // A chat export needs its upload; its type is a chat's, and only it holds a chat summary.
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, created_by) values ($1, 'chat', 'Chat export', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_file_ck/);
      await expect(
        owner.query(`update kb_sources set file_type = 'pdf' where id = $1`, [a]),
      ).rejects.toThrow(/kb_sources_chat_type_ck/);
      await expect(
        owner.query(
          `insert into kb_sources (tenant_id, kind, name, upload_key, file_size, chat, created_by)
           values ($1, 'file', 'x.pdf', 'k3', 1, '{}', 'u')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/kb_sources_chat_ck/);
    } finally {
      await owner.query(`delete from kb_source_pages where source_id = $1`, [a]);
      await cleanup();
    }
  });

  it("the dashboard adds allowed origins to its own tenant only, and can't change other tenant columns", async () => {
    const { rows: before } = await owner.query(
      `select allowed_origins from tenants where id = $1`,
      [TENANT_B],
    );
    try {
      await asRole('app_dashboard', TENANT_B, async (c) => {
        await c.query(
          `update tenants set allowed_origins = allowed_origins || '{https://b.example}'::text[]`,
        );
        expect(
          (await c.query(`update tenants set allowed_origins = '{}' where id = $1`, [TENANT_A]))
            .rowCount,
        ).toBe(0);
      });
      await expect(
        asRole('app_ingest', TENANT_B, (c) => c.query(`update tenants set allowed_origins = '{}'`)),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query(`update tenants set allowed_origins = $2 where id = $1`, [
        TENANT_B,
        before[0].allowed_origins,
      ]);
    }
  });
});

describe('coaching and corrections (FEAT-027)', () => {
  const ids: Record<string, { session: string; correction: string }> = {};
  beforeAll(async () => {
    for (const t of [TENANT_A, TENANT_B]) {
      const s = await owner.query(
        `insert into coaching_sessions (tenant_id, created_by, origin) values ($1, gen_random_uuid(), 'coach') returning id`,
        [t],
      );
      await owner.query(
        `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body) values ($1, $2, 1, 'owner', 'question', $3)`,
        [t, s.rows[0].id, `coached by ${t}`],
      );
      const c = await owner.query(
        `insert into corrections (tenant_id, source_type, proposed_by, coaching_session_id, proposed_change)
         values ($1, 'coaching', 'coaching', $2, '{"kind":"add_faq"}') returning id`,
        [t, s.rows[0].id],
      );
      ids[t] = { session: s.rows[0].id, correction: c.rows[0].id };
    }
  });

  it.each(['coaching_sessions', 'coaching_messages', 'corrections'])(
    'the visitor role has no grant on %s (ADR-009)',
    async (table) => {
      await expect(
        asRole('app_agent_visitor', TENANT_A, (c) => c.query(`select * from ${table}`)),
      ).rejects.toThrow(/permission denied/);
    },
  );

  it("tenant B's dashboard can't read or change tenant A's sessions, messages or corrections", async () => {
    await asRole('app_dashboard', TENANT_B, async (c) => {
      for (const table of ['coaching_sessions', 'coaching_messages', 'corrections']) {
        const rows = (await c.query(`select tenant_id from ${table}`)).rows;
        expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
      }
      expect(
        (
          await c.query(
            `update corrections set status = 'dismissed', decided_at = now() where id = $1`,
            [ids[TENANT_A]!.correction],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await c.query(`update coaching_sessions set title = 'x' where id = $1`, [
            ids[TENANT_A]!.session,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        c.query(
          `insert into coaching_sessions (tenant_id, created_by, origin) values ($1, gen_random_uuid(), 'coach')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('the dashboard may change only the decision columns of a correction, and never delete', async () => {
    await asRole('app_dashboard', TENANT_A, async (c) => {
      await expect(
        c.query(`update corrections set proposed_change = '{}' where id = $1`, [
          ids[TENANT_A]!.correction,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole('app_dashboard', TENANT_A, async (c) => {
      await expect(c.query(`delete from coaching_messages`)).rejects.toThrow(/permission denied/);
    });
  });

  it('a decided correction has a decision time, and a coaching one has its session', async () => {
    await expect(
      owner.query(`update corrections set status = 'accepted' where id = $1`, [
        ids[TENANT_A]!.correction,
      ]),
    ).rejects.toThrow(/corrections_decided_ck/);
    await expect(
      owner.query(
        `insert into corrections (tenant_id, source_type, proposed_by, proposed_change) values ($1, 'coaching', 'coaching', '{}')`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/corrections_coaching_ck/);
  });

  it("a replay session belongs to its conversation, and tenant B can't see tenant A's (FEAT-028)", async () => {
    const replays: Record<string, string> = {};
    for (const t of [TENANT_A, TENANT_B]) {
      const conv = await owner.query(
        `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
        [t],
      );
      const s = await owner.query(
        `insert into coaching_sessions (tenant_id, created_by, origin, replay_conversation_id)
         values ($1, gen_random_uuid(), 'replay', $2) returning id`,
        [t, conv.rows[0].id],
      );
      await owner.query(
        `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body, replay_of, replay_conversation_id)
         values ($1, $2, 1, 'agent', 'replay', 'replayed', gen_random_uuid(), $3)`,
        [t, s.rows[0].id, conv.rows[0].id],
      );
      replays[t] = conv.rows[0].id;
    }
    await asRole('app_dashboard', TENANT_B, async (c) => {
      const rows = (
        await c.query(`select tenant_id from coaching_sessions where origin = 'replay'`)
      ).rows;
      expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
      await expect(
        c.query(
          `insert into coaching_sessions (tenant_id, created_by, origin, replay_conversation_id)
           values ($1, gen_random_uuid(), 'replay', $2)`,
          [TENANT_B, replays[TENANT_A]],
        ),
      ).rejects.toThrow(/foreign key/);
    });
    await expect(
      asRole('app_agent_visitor', TENANT_A, (c) =>
        c.query(`select * from coaching_sessions where origin = 'replay'`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner.query(
        `insert into coaching_sessions (tenant_id, created_by, origin) values ($1, gen_random_uuid(), 'replay')`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/coaching_sessions_replay_ck/);

    await owner.query(`delete from conversations where tenant_id = $1 and id = $2`, [
      TENANT_A,
      replays[TENANT_A],
    ]);
    const left = await owner.query(
      `select (select count(*) from coaching_sessions where replay_conversation_id = $1)::int as sessions,
              (select count(*) from coaching_messages m where m.tenant_id = $2 and m.kind = 'replay')::int as answers`,
      [replays[TENANT_A], TENANT_A],
    );
    expect(left.rows[0]).toEqual({ sessions: 0, answers: 0 });
  });

  it('a usage row belongs to a conversation or a coaching session, never both', async () => {
    await expect(
      owner.query(
        `insert into usage_events (tenant_id, conversation_id, coaching_session_id, purpose, model, provider, provider_model_id, cost_usd)
         values ($1, gen_random_uuid(), $2, 'reply', 'm', 'p', 'x', 0)`,
        [TENANT_A, ids[TENANT_A]!.session],
      ),
    ).rejects.toThrow(/usage_events_owner_ck/);
  });
});

// ---- FEAT-018: stale items, correction replays and the stale scan (FEAT-018 §4; AC-1, AC-8) ---

describe('corrections queue (FEAT-018)', () => {
  const ids: Record<string, { fact: string; stale: string; session: string; conv: string }> = {};
  beforeAll(async () => {
    for (const t of [TENANT_A, TENANT_B]) {
      const f = await owner.query(
        `insert into facts (tenant_id, type, status, value) values ($1, 'faq', 'approved', '{"question":"q","answer":"a"}') returning id`,
        [t],
      );
      const stale = await owner.query(
        `insert into corrections (tenant_id, source_type, proposed_by, fact_refs, proposed_change)
         values ($1, 'stale', 'system', array[$2::uuid], '{"kind":"reconfirm"}') returning id`,
        [t, f.rows[0].id],
      );
      const accepted = await owner.query(
        `insert into corrections (tenant_id, source_type, proposed_by, fact_refs, proposed_change, status, decided_at)
         values ($1, 'stale', 'system', array[$2::uuid], '{"kind":"reconfirm"}', 'accepted', now()) returning id`,
        [t, f.rows[0].id],
      );
      const conv = await owner.query(
        `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
        [t],
      );
      const s = await owner.query(
        `insert into coaching_sessions (tenant_id, created_by, origin, correction_id) values ($1, gen_random_uuid(), 'correction', $2) returning id`,
        [t, accepted.rows[0].id],
      );
      await owner.query(
        `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body, replay_of, replay_conversation_id)
         values ($1, $2, 1, 'agent', 'replay', 'replayed', gen_random_uuid(), $3)`,
        [t, s.rows[0].id, conv.rows[0].id],
      );
      ids[t] = {
        fact: f.rows[0].id,
        stale: stale.rows[0].id,
        session: s.rows[0].id,
        conv: conv.rows[0].id,
      };
    }
  });

  it("tenant B can't read or decide tenant A's stale items or correction replays", async () => {
    await asRole('app_dashboard', TENANT_B, async (c) => {
      const items = await c.query(
        `select id from corrections where source_type = 'stale' and status = 'open'`,
      );
      expect(items.rows.map((r) => r.id)).toEqual([ids[TENANT_B]!.stale]);
      const upd = await c.query(
        `update corrections set status = 'dismissed', decided_at = now() where id = $1`,
        [ids[TENANT_A]!.stale],
      );
      expect(upd.rowCount).toBe(0);
      const sessions = await c.query(
        `select tenant_id from coaching_sessions where origin = 'correction'`,
      );
      expect(sessions.rows.map((r) => r.tenant_id)).toEqual([TENANT_B]);
      const answers = await c.query(
        `select tenant_id from coaching_messages where replay_conversation_id is not null and session_id = $1`,
        [ids[TENANT_A]!.session],
      );
      expect(answers.rows).toEqual([]);
    });
  });

  it('one open stale item per fact, one replay per correction, and the checks hold', async () => {
    await expect(
      owner.query(
        `insert into corrections (tenant_id, source_type, proposed_by, fact_refs, proposed_change)
         values ($1, 'stale', 'system', array[$2::uuid], '{"kind":"reconfirm"}')`,
        [TENANT_A, ids[TENANT_A]!.fact],
      ),
    ).rejects.toThrow(/corrections_open_stale_uq/);
    await expect(
      owner.query(
        `update corrections set status = 'edited_and_accepted', decided_at = now() where id = $1`,
        [ids[TENANT_A]!.stale],
      ),
    ).rejects.toThrow(/corrections_accepted_change_ck/);
    await expect(
      owner.query(
        `insert into coaching_sessions (tenant_id, created_by, origin) values ($1, gen_random_uuid(), 'correction')`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/coaching_sessions_correction_ck/);
    await expect(
      owner.query(
        `insert into coaching_messages (tenant_id, session_id, seq, author, kind, body, replay_of)
         values ($1, $2, 2, 'agent', 'replay', 'x', gen_random_uuid())`,
        [TENANT_A, ids[TENANT_A]!.session],
      ),
    ).rejects.toThrow(/coaching_messages_replay_conversation_ck/);
    await expect(
      owner.query(
        `update tenants set fact_review_months = '{"product":0,"faq":6,"policy":6,"promotion":6}' where id = $1`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/tenants_fact_review_months_ck/);
  });

  it("the dashboard saves its own tenant's review intervals only", async () => {
    await asRole('app_dashboard', TENANT_B, async (c) => {
      const upd = await c.query(
        `update tenants set fact_review_months = '{"product":3,"faq":6,"policy":12,"promotion":1}' where id = $1`,
        [TENANT_A],
      );
      expect(upd.rowCount).toBe(0);
      const own = await c.query(
        `update tenants set fact_review_months = '{"product":3,"faq":6,"policy":12,"promotion":1}' where id = $1`,
        [TENANT_B],
      );
      expect(own.rowCount).toBe(1);
    });
  });

  it('deleting a conversation removes its replayed answers from a correction replay', async () => {
    await owner.query(`delete from conversations where tenant_id = $1 and id = $2`, [
      TENANT_A,
      ids[TENANT_A]!.conv,
    ]);
    const left = await owner.query(
      `select (select count(*) from coaching_sessions where tenant_id = $1 and id = $2)::int as sessions,
              (select count(*) from coaching_messages where tenant_id = $1 and session_id = $2)::int as answers`,
      [TENANT_A, ids[TENANT_A]!.session],
    );
    expect(left.rows[0]).toEqual({ sessions: 1, answers: 0 });
  });

  it('only the outbox zone may run the stale scan, and it reads nothing else', async () => {
    await asRole('app_outbox', null, (c) => c.query(`select * from kb_stale_scan()`));
    await expect(asRole('app_outbox', null, (c) => c.query(`select * from facts`))).rejects.toThrow(
      /permission denied/,
    );
    for (const role of [
      'app_agent_visitor',
      'app_dashboard',
      'app_identity',
      'app_ingest',
    ] as const)
      await expect(
        asRole(role, TENANT_A, (c) => c.query(`select * from kb_stale_scan()`)),
      ).rejects.toThrow(/permission denied/);
    const login = await owner.query(
      `select rolcanlogin from pg_roles where rolname = 'kaki_stale_scan'`,
    );
    expect(login.rows).toEqual([{ rolcanlogin: false }]);
  });
});
