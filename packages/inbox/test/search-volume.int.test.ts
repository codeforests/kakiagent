/**
 * The INB-11 performance proof (FEAT-046 §5.4, AC-4): 12 months of A1 volume for one
 * tenant (60,000 conversations, 480,000 messages) plus a second tenant with 100,000
 * messages holding the same needles; every first page ≤ 2,000 ms, worst of 3 runs.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchConversations, searchPatterns } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;

const WORDS =
  'hello hi thanks please cake order pickup delivery tomorrow today price menu birthday chocolate vanilla strawberry durian slice whole box gift card open close hours weekend saturday sunday morning evening how much is the do you have can I get want need for my a an and or with without sugar less more small large size inch candles message write name address postal code time slot available sorry yes no okay sure great perfect wait minute check stock sold out next week reserve deposit pay paynow cash bank transfer receipt invoice discount promo member points refund change cancel late early collect shop outlet branch near mrt station parking halal eggless vegan gluten nut free allergy fresh baked bread bun tart puff croissant cookie muffin brownie roll swiss layer mousse cheese mango pandan'
    .split(' ')
    .filter((w) => w !== 'pandan'); // 'pandan' is the planted common word, never random
const COMMON = 'pandan';
const RARE_EMAIL = 'rare.person.zq@example.org';
const NAME = '陈美玲';

/** Seeds `convs` conversations of 8 messages each over the last 365 days. */
async function seed(tenantId: string, convs: number) {
  const step = Math.floor((365 * 86_400) / convs);
  await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id, status, last_message_at, closed_at, close_reason)
     select $1, 'widget', gen_random_uuid(), x.status, x.at,
            case when x.status = 'closed' then x.at end,
            case when x.status = 'closed' then 'inactive' end
     from (select case when g % 3 = 0 then 'closed' else 'ai' end as status,
                  now() - make_interval(secs => g * $3::int) as at
           from generate_series(1, $2::int) g) x`,
    [tenantId, convs, step],
  );
  await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, created_at)
     select c.tenant_id, c.id, case when n % 2 = 1 then 'visitor' else 'agent' end,
            (select string_agg(($2::text[])[1 + floor(random() * array_length($2::text[], 1))::int], ' ')
               from generate_series(1, 6 + (n + k) % 10) k)
            || case when random() < 0.1 then ' ' || $3 else '' end,
            c.last_message_at - make_interval(mins => 8 - n)
     from (select *, row_number() over () as k from conversations where tenant_id = $1) c
     cross join generate_series(1, 8) n`,
    [tenantId, WORDS, COMMON],
  );
}

/** Plants the needles in `count` random messages of the tenant. */
async function plant(tenantId: string, text: string, count: number) {
  await owner.query(
    `update messages set body = body || ' ' || $2
     where (tenant_id, id) in (select tenant_id, id from messages where tenant_id = $1
                               order by random() limit $3)`,
    [tenantId, text, count],
  );
}

const QUERIES: [label: string, q: string][] = [
  ['rare email', RARE_EMAIL],
  ['email part', 'person.zq@'],
  ['phone 91234567', '91234567'],
  ['phone 9123 4567', '9123 4567'],
  ['phone +65-9123-4567', '+65-9123-4567'],
  ['2-char Chinese', '美玲'],
  ['common word', COMMON],
  // FEAT-049 §5.5: the contact's fields, with 5,000 contacts on tenant A.
  ['contact name', 'Zephyrine'],
  ['contact phone', '8765 4321'],
];

const timings: Record<string, number> = {};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const t = Date.now();
  await seed(TENANT_A, 60_000);
  await seed(TENANT_B, 12_500);
  for (const tenant of [TENANT_A, TENANT_B]) {
    await plant(tenant, `email me at ${RARE_EMAIL}`, 1);
    await plant(tenant, 'call 91234567', 1);
    await plant(tenant, 'or +65 9123 4567', 1);
    await plant(tenant, 'whatsapp 9123-4567', 1);
    await plant(tenant, `我是${NAME}`, 30);
  }
  // FEAT-049 (AC-10): 5,000 contacts on tenant A, each on one conversation; one has the needles.
  await owner.query(
    `with picked as (select id, row_number() over () as n from conversations where tenant_id = $1 limit 5000),
     made as (insert into contacts (tenant_id, name, email, phone)
       select $1, 'Contact ' || n, 'person' || n || '@example.com', '+659' || lpad(n::text, 7, '0')
       from picked returning id, (regexp_match(name, '[0-9]+'))[1]::int as n)
     update conversations c set contact_id = made.id from picked, made
     where c.tenant_id = $1 and c.id = picked.id and picked.n = made.n`,
    [TENANT_A],
  );
  await owner.query(
    `update contacts set name = 'Zephyrine Goh', phone = '+6587654321' where tenant_id = $1 and name = 'Contact 77'`,
    [TENANT_A],
  );
  await owner.query('vacuum analyze contacts');
  await owner.query('vacuum analyze messages');
  await owner.query('vacuum analyze conversations');
  console.warn(`seeded in ${Date.now() - t} ms`);
}, 600_000);

afterAll(async () => {
  console.warn(`search timings (worst of 3, ms): ${JSON.stringify(timings)}`);
  await owner?.end();
  await tdb?.stop();
});

describe('search at A1 volume (AC-4)', () => {
  it('seeded 12 months of A1 volume', async () => {
    const { rows } = await owner.query(
      `select (select count(*) from conversations where tenant_id = $1)::int as convs,
              (select count(*) from messages where tenant_id = $1)::int as msgs,
              (select count(*) from messages where tenant_id = $2)::int as b_msgs`,
      [TENANT_A, TENANT_B],
    );
    expect(rows[0]).toEqual({ convs: 60_000, msgs: 480_000, b_msgs: 100_000 });
    const linked = await owner.query(
      `select count(*)::int as n from conversations where tenant_id = $1 and contact_id is not null`,
      [TENANT_A],
    );
    expect(linked.rows[0].n).toBe(5_000);
  });

  it.each(QUERIES)('%s: first page ≤ 2,000 ms', async (label, q) => {
    let worst = 0;
    let found: string[] = [];
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      const out = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        searchConversations(tx, TENANT_A, { q, limit: 25 }),
      );
      worst = Math.max(worst, performance.now() - t);
      found = out.results.map((r) => r.conversation.id);
    }
    timings[label] = Math.round(worst);
    expect(found.length).toBeGreaterThan(0);
    // Every hit is tenant A's.
    const { rows } = await owner.query(
      `select count(*)::int as n from conversations where id = any($1::uuid[]) and tenant_id <> $2`,
      [found, TENANT_A],
    );
    expect(rows[0].n).toBe(0);
    expect(worst).toBeLessThanOrEqual(2_000);
  });

  it('finds every planted phone spelling and the 30 name messages', async () => {
    const page = (q: string, limit = 50) =>
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        searchConversations(tx, TENANT_A, { q, limit }),
      );
    expect((await page('9123 4567')).results).toHaveLength(3);
    expect((await page(RARE_EMAIL)).results).toHaveLength(1);
    const { rows } = await owner.query(
      `select count(distinct conversation_id)::int as n from messages where tenant_id = $1 and body like $2`,
      [TENANT_A, `%${NAME}%`],
    );
    expect((await page('美玲')).results).toHaveLength(rows[0].n);
  });

  it('plans: rare and common terms use both index columns', async () => {
    for (const q of [RARE_EMAIL, COMMON, '美玲']) {
      const p = searchPatterns(q)!;
      // The body of inbox_search_hits() as its owner role sees it (0047, build note B1).
      await owner.query('begin');
      await owner.query('set local role kaki_inbox_search');
      await owner.query(`select set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const r = await owner.query(
        `explain (analyze, buffers, format text)
         select distinct on (m.conversation_id) m.tenant_id, m.conversation_id, m.id, m.author, m.body, m.created_at
         from messages m where m.tenant_id = app_current_tenant() and m.body ilike any ($1::text[])
         order by m.conversation_id, m.seq desc`,
        [p],
      );
      await owner.query('rollback');
      const plan = (r.rows as { 'QUERY PLAN': string }[]).map((x) => x['QUERY PLAN']);
      const lines = plan.filter((l) => /Index Cond|Bitmap Index|Seq Scan|Execution Time/.test(l));
      console.warn(`plan for ${q === RARE_EMAIL ? 'rare email' : q}:\n${lines.join('\n')}`);
      // A 2-character query has no trigram to look up, so it reads the tenant's rows (still ≤ 2 s).
      if (q === '美玲') continue;
      expect(plan.some((l) => /messages_search_trgm_idx/.test(l))).toBe(true);
      expect(plan.some((l) => /Index Cond: .*~~\*/.test(l))).toBe(true);
    }
    const lc = await owner.query(
      `select datctype from pg_database where datname = current_database()`,
    );
    console.warn(`lc_ctype: ${lc.rows[0].datctype}`);
  });
});
