import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Login roles, one per trust zone (ADR-005). Created by the migration owner, outside migrations, because they carry passwords. */
export const LOGIN_ROLES = [
  'app_dashboard',
  'app_agent_visitor',
  'app_outbox',
  'app_identity',
  'app_ingest',
] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

export interface SeedTenant {
  id: string;
  slug: string;
  name: string;
  widgetKey: string;
  allowedOrigins: string[];
  /** KB-15: the bakery quotes GST-inclusive prices; the second tenant isn't registered. */
  gstRegistered: boolean;
  /** The seeded Owner, who signs in by magic link (FEAT-005). */
  ownerEmail: string;
  /** Other seeded members (FEAT-043: an agent with a display name for the takeover E2E). */
  members?: { email: string; displayName: string; role: 'admin' | 'agent' }[];
  /** Weekly opening hours in SGT (AGT-09, FEAT-023); null: not set. */
  hours: Record<string, { open: string; close: string }[]> | null;
  openOnPublicHolidays: boolean;
  /** The rest of the business profile (ONB-03, FEAT-009 §5.5); null: not set. */
  profile: {
    uen: string;
    industry: string;
    contactEmail: string;
    contactPhone: string;
    languages: string[];
  } | null;
  /**
   * Saved privacy wordings so the dev widget captures leads (FEAT-049 §5.9); `marketing` turns
   * the opt-in on; `leads` adds the sample contact-form leads (FEAT-050 §5.7). The test database
   * leaves it out: suites start with nothing saved and no leads.
   */
  privacy?: { marketing: boolean; leads?: boolean };
}

const SEED_PURPOSE = {
  purpose: {
    en: "We'll use your name and contact details to reply to your enquiry and follow up about it. We won't use them for anything else without asking.",
    zh: '我们会使用您的姓名和联系方式回复您的询问并跟进。未经您同意，我们不会将其用于其他用途。',
  },
  consentPrompt: {
    en: 'Is it OK for us to use your details for this?',
    zh: '可以为此使用您的资料吗？',
  },
  wordingVersion: '2026-10-27',
};
const SEED_MARKETING = {
  text: {
    en: 'Also send me news and offers. I can stop these at any time.',
    zh: '也请向我发送新闻和优惠。我可以随时取消。',
  },
};
/** The F&B lead fields (FEAT-049 §5.1): `INDUSTRY_TEMPLATES.fnb.leadFields`. */
const SEED_LEAD_FIELDS = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'optional' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'off' },
  { key: 'preferredTime', mode: 'optional' },
];

/** The bakery's scoring criteria (FEAT-050 §5.7): the F&B keywords and a S$300 minimum. */
export const SEED_QUALIFICATION = {
  keywords: ['wedding', 'corporate', 'event', '婚礼'],
  minBudget: 300,
};

type SeedReason = { code: string; points: number; detail: string | null };
/**
 * Sample contact-form leads for the dev bakery (FEAT-050 §5.7): no conversation, so the inbox
 * lists and search are unchanged. Scores are what leads `scoreLead` gives with
 * `SEED_QUALIFICATION` (its unit test checks each one); `marketing` null = not asked.
 */
export const SEED_LEADS: readonly {
  name: string;
  email: string | null;
  phone: string | null;
  need: string;
  budget: string | null;
  preferredTime: string | null;
  status: 'new' | 'contacted' | 'won' | 'lost';
  marketing: boolean | null;
  hoursAgo: number;
  score: { score: 'hot' | 'warm' | 'cold'; points: number; reasons: SeedReason[] };
}[] = [
  {
    name: 'Rachel Tan',
    email: 'rachel.tan@example.com',
    phone: '+6591230001',
    need: 'Wedding cake for 120 guests, three tiers',
    budget: 'S$800',
    preferredTime: 'Sat 12 Dec',
    status: 'new',
    marketing: true,
    hoursAgo: 2,
    score: {
      score: 'hot',
      points: 7,
      reasons: [
        { code: 'keyword', points: 2, detail: 'wedding' },
        { code: 'budget_met', points: 2, detail: '300' },
        { code: 'both_contacts', points: 1, detail: null },
        { code: 'need_given', points: 1, detail: null },
        { code: 'timing_given', points: 1, detail: null },
      ],
    },
  },
  {
    name: 'Daniel Lim',
    email: 'daniel.lim@example.com',
    phone: null,
    need: 'Corporate order of 60 cupcakes',
    budget: null,
    preferredTime: 'Next Friday',
    status: 'new',
    marketing: false,
    hoursAgo: 5,
    score: {
      score: 'warm',
      points: 4,
      reasons: [
        { code: 'keyword', points: 2, detail: 'corporate' },
        { code: 'need_given', points: 1, detail: null },
        { code: 'timing_given', points: 1, detail: null },
      ],
    },
  },
  {
    name: 'Siti Rahman',
    email: null,
    phone: '+6581230003',
    need: 'Do you sell bread loaves?',
    budget: null,
    preferredTime: null,
    status: 'new',
    marketing: null,
    hoursAgo: 26,
    score: { score: 'cold', points: 1, reasons: [{ code: 'need_given', points: 1, detail: null }] },
  },
  {
    name: 'Grace Wong',
    email: 'grace.wong@example.com',
    phone: '+6591230004',
    need: 'Birthday cake for my son',
    budget: 'S$120',
    preferredTime: 'Last Sunday',
    status: 'won',
    marketing: null,
    hoursAgo: 72,
    score: {
      score: 'warm',
      points: 3,
      reasons: [
        { code: 'budget_below', points: 0, detail: '300' },
        { code: 'both_contacts', points: 1, detail: null },
        { code: 'need_given', points: 1, detail: null },
        { code: 'timing_given', points: 1, detail: null },
      ],
    },
  },
];

const weekday = [{ open: '08:00', close: '19:00' }];
/** The bakery's hours (FEAT-023 §5.8): Mon–Fri 8 am–7 pm, Sat 9 am–5 pm, Sun 9 am–1 pm. */
export const BAKERY_HOURS = {
  mon: weekday,
  tue: weekday,
  wed: weekday,
  thu: weekday,
  fri: weekday,
  sat: [{ open: '09:00', close: '17:00' }],
  sun: [{ open: '09:00', close: '13:00' }],
};

/**
 * The terms version the seeded owners accepted. `@kaki/identity`'s test keeps it equal
 * to `CURRENT_TERMS`, so the seed always looks like a tenant that accepted the current
 * terms (AUTH-08).
 */
export const SEED_TERMS_VERSION = '2026-10-20';

/** The bakery and a second tenant (plan §7), with fixed IDs so tests and demos can refer to them. */
export function devTenants(allowedOrigins: string[]): SeedTenant[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'kaki-bakery',
      name: 'Kaki Bakery',
      widgetKey: 'wk_dev_bakery',
      allowedOrigins,
      gstRegistered: true,
      ownerEmail: 'owner@kaki-bakery.test',
      members: [{ email: 'agent@kaki-bakery.test', displayName: 'Mei Ling', role: 'agent' }],
      hours: BAKERY_HOURS,
      openOnPublicHolidays: false,
      profile: {
        uen: '201912345K',
        industry: 'fnb',
        contactEmail: 'hello@kaki-bakery.test',
        contactPhone: '+6591234567',
        languages: ['en', 'zh'],
      },
      privacy: { marketing: true, leads: true },
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'second-tenant',
      name: 'Second Tenant Pte Ltd',
      widgetKey: 'wk_dev_second',
      allowedOrigins,
      gstRegistered: false,
      ownerEmail: 'owner@second-tenant.test',
      hours: null,
      openOnPublicHolidays: false,
      profile: null,
      privacy: { marketing: false },
    },
  ];
}

/** Creates or updates the login roles. Idempotent. Runs as the migration owner. */
export async function bootstrapRoles(
  client: pg.ClientBase,
  passwords: Record<LoginRole, string>,
): Promise<void> {
  for (const role of LOGIN_ROLES) {
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    const verb = exists.rowCount ? 'alter' : 'create';
    const { rows } = await client.query<{ stmt: string }>(
      `select format('${verb} role %I with login password %L nosuperuser nobypassrls nocreatedb nocreaterole', $1::text, $2::text) as stmt`,
      [role, passwords[role]],
    );
    await client.query(rows[0]!.stmt);
  }
}

export async function seed(client: pg.ClientBase, tenants: SeedTenant[]): Promise<void> {
  for (const t of tenants) {
    await client.query(
      `insert into tenants (id, slug, name, widget_key, allowed_origins)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set name = excluded.name, widget_key = excluded.widget_key,
         allowed_origins = excluded.allowed_origins`,
      [t.id, t.slug, t.name, t.widgetKey, t.allowedOrigins],
    );
    await client.query(
      `insert into widget_settings (tenant_id) values ($1) on conflict (tenant_id) do nothing`,
      [t.id],
    );
    // New tenants start offline (trigger, FEAT-034 D3); the dev tenants answer from the start.
    await client.query(
      `insert into channel_connections (tenant_id, kind, state, state_changed_at, health)
       values ($1, 'widget', 'live', now(), 'ok')
       on conflict (tenant_id, kind) do update set state = 'live',
         state_changed_at = coalesce(channel_connections.state_changed_at, now())`,
      [t.id],
    );
    // Seeded live, so already past the first go-live (FEAT-035 D4).
    await client.query(
      `insert into onboarding_progress (tenant_id, current_step, first_live_at)
       values ($1, 'go_live', now())
       on conflict (tenant_id) do update set
         first_live_at = coalesce(onboarding_progress.first_live_at, now())`,
      [t.id],
    );
    await client.query(
      `insert into business_profiles (tenant_id, gst_registered, hours, open_on_public_holidays,
         uen, industry, contact_email, contact_phone, languages)
       values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, '{en}'::text[]))
       on conflict (tenant_id) do update set gst_registered = excluded.gst_registered,
         hours = excluded.hours, open_on_public_holidays = excluded.open_on_public_holidays,
         uen = excluded.uen, industry = excluded.industry, contact_email = excluded.contact_email,
         contact_phone = excluded.contact_phone, languages = excluded.languages,
         updated_at = now()`,
      [
        t.id,
        t.gstRegistered,
        t.hours,
        t.openOnPublicHolidays,
        t.profile?.uen ?? null,
        t.profile?.industry ?? null,
        t.profile?.contactEmail ?? null,
        t.profile?.contactPhone ?? null,
        t.profile?.languages ?? null,
      ],
    );
    const user = await client.query<{ id: string }>(
      `insert into users (email) values ($1)
       on conflict (email) do update set email = excluded.email returning id`,
      [t.ownerEmail],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')
       on conflict (tenant_id, user_id) do nothing`,
      [t.id, userId],
    );
    for (const m of t.members ?? []) {
      const member = await client.query<{ id: string }>(
        `insert into users (email, display_name) values ($1, $2)
         on conflict (email) do update set display_name = coalesce(users.display_name, excluded.display_name)
         returning id`,
        [m.email, m.displayName],
      );
      await client.query(
        `insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)
         on conflict (tenant_id, user_id) do nothing`,
        [t.id, member.rows[0]!.id, m.role],
      );
    }
    await client.query(
      `insert into terms_acceptances (tenant_id, user_id, document, version)
       select $1, $2, d, $3 from unnest(array['tos', 'aup', 'dpa']) as d
       where not exists (select 1 from terms_acceptances where tenant_id = $1 and version = $3)`,
      [t.id, userId, SEED_TERMS_VERSION],
    );
    if (t.privacy)
      await seedPrivacy(client, t.id, userId, t.ownerEmail, t.privacy.marketing, !!t.privacy.leads);
    if (t.privacy?.leads) {
      await seedLeads(client, t.id);
      await seedContactIdentities(client, t.id);
    }
  }
}

/** The second contact of the bakery's suggested-duplicate pair (FEAT-039 D10): no lead, no chat. */
export const SEED_DUPLICATE = { name: 'R. Tan', email: 'rachel.tan@example.com' } as const;

/**
 * The seeded leads' typed email and phone as lead-form identities, and one contact sharing
 * Rachel Tan's email so the Contact page has a possible duplicate (FEAT-039 §5.5, D10).
 * Idempotent: identities are unique per (contact, kind, value, source).
 */
async function seedContactIdentities(client: pg.ClientBase, tenantId: string): Promise<void> {
  const pair = await client.query(
    `select 1 from contacts where tenant_id = $1 and name = $2 and email = $3`,
    [tenantId, SEED_DUPLICATE.name, SEED_DUPLICATE.email],
  );
  if (!pair.rowCount)
    await client.query(
      `insert into contacts (tenant_id, name, email, created_at, updated_at)
       values ($1, $2, $3, now() - interval '30 days', now() - interval '30 days')`,
      [tenantId, SEED_DUPLICATE.name, SEED_DUPLICATE.email],
    );
  for (const l of [...SEED_LEADS, { ...SEED_DUPLICATE, phone: null }])
    for (const [kind, value] of [
      ['email', l.email],
      ['phone', l.phone],
    ] as const)
      if (value)
        await client.query(
          `insert into contact_identities (tenant_id, contact_id, kind, value, source, created_at)
           select tenant_id, id, $3, $4, 'lead_form', created_at from contacts
           where tenant_id = $1 and name = $2 and ${kind} = $4
           on conflict do nothing`,
          [tenantId, l.name, kind, value],
        );
}

/** A saved notice and purpose statement, and lead settings, unless the owner saved their own. */
async function seedPrivacy(
  client: pg.ClientBase,
  tenantId: string,
  userId: string,
  email: string,
  marketing: boolean,
  withLeads: boolean,
): Promise<void> {
  const wording = async (kind: string, content: unknown) =>
    (
      await client.query<{ id: string }>(
        `insert into wording_versions (tenant_id, kind, seq, content, created_by)
         values ($1, $2, coalesce((select max(seq) from wording_versions where tenant_id = $1 and kind = $2), 0) + 1, $3, $4)
         returning id`,
        [tenantId, kind, JSON.stringify(content), userId],
      )
    ).rows[0]!.id;
  const saved = await client.query(`select 1 from privacy_settings where tenant_id = $1`, [
    tenantId,
  ]);
  if (saved.rowCount === 0) {
    const notice = await wording('privacy_notice', {
      mode: 'template',
      templateVersion: '2026-10-27',
      fields: {
        contactName: 'Data Protection Officer',
        contactEmail: email,
        contactPhone: null,
        address: null,
        extra: null,
      },
    });
    const purpose = await wording('purpose_statement', SEED_PURPOSE);
    await client.query(
      `insert into privacy_settings (tenant_id, notice_wording_id, purpose_wording_id) values ($1, $2, $3)`,
      [tenantId, notice, purpose],
    );
  }
  const leads = await client.query(`select 1 from lead_settings where tenant_id = $1`, [tenantId]);
  if (leads.rowCount === 0) {
    const marketingId = marketing ? await wording('marketing_consent', SEED_MARKETING) : null;
    await client.query(
      `insert into lead_settings (tenant_id, fields, marketing_enabled, marketing_wording_id, qualification)
       values ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        JSON.stringify(SEED_LEAD_FIELDS),
        marketing,
        marketingId,
        JSON.stringify(withLeads ? SEED_QUALIFICATION : { keywords: [], minBudget: null }),
      ],
    );
  }
}

/**
 * The sample leads (FEAT-050 §5.7), once: a contact that already exists (by email or phone)
 * is left alone with its leads, so a second run changes nothing.
 */
async function seedLeads(client: pg.ClientBase, tenantId: string): Promise<void> {
  const ids = await client.query<{ purpose: string | null; marketing: string | null }>(
    `select p.purpose_wording_id as purpose, l.marketing_wording_id as marketing
     from privacy_settings p left join lead_settings l on l.tenant_id = p.tenant_id
     where p.tenant_id = $1`,
    [tenantId],
  );
  const purpose = ids.rows[0]?.purpose;
  if (!purpose) return;
  for (const l of SEED_LEADS) {
    const exists = await client.query(
      `select 1 from contacts where tenant_id = $1 and (email = $2 or phone = $3)`,
      [tenantId, l.email, l.phone],
    );
    if (exists.rowCount) continue;
    const at = `now() - interval '${l.hoursAgo} hours'`;
    const contact = (
      await client.query<{ id: string }>(
        `insert into contacts (tenant_id, name, email, phone, created_at, updated_at)
         values ($1, $2, $3, $4, ${at}, ${at}) returning id`,
        [tenantId, l.name, l.email, l.phone],
      )
    ).rows[0]!.id;
    const consent = (
      await client.query<{ id: string }>(
        `insert into consents (tenant_id, contact_id, purpose, decision, wording_id, channel, created_at)
         values ($1, $2, 'enquiry', 'agreed', $3, 'widget', ${at}) returning id`,
        [tenantId, contact, purpose],
      )
    ).rows[0]!.id;
    if (l.marketing !== null && ids.rows[0]?.marketing)
      await client.query(
        `insert into consents (tenant_id, contact_id, purpose, decision, wording_id, channel, created_at)
         values ($1, $2, 'marketing', $3, $4, 'widget', ${at})`,
        [tenantId, contact, l.marketing ? 'agreed' : 'declined', ids.rows[0].marketing],
      );
    await client.query(
      `insert into leads (tenant_id, contact_id, consent_id, status, need, budget, preferred_time,
         score, score_points, score_reasons, scored_at, hot_alerted_at, status_changed_at,
         created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${at}, $11, $12, ${at}, ${at})`,
      [
        tenantId,
        contact,
        consent,
        l.status,
        l.need,
        l.budget,
        l.preferredTime,
        l.score.score,
        l.score.points,
        JSON.stringify(l.score.reasons),
        l.score.score === 'hot' ? new Date(Date.now() - l.hoursAgo * 3_600_000) : null,
        l.status === 'new' ? null : new Date(Date.now() - (l.hoursAgo - 1) * 3_600_000),
      ],
    );
  }
}

/** Roles → migrations → seed. `ownerUrl` connects as the role that owns the schema. */
export async function setupDatabase(opts: {
  ownerUrl: string;
  passwords: Record<LoginRole, string>;
  seedTenants?: SeedTenant[];
}): Promise<void> {
  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  try {
    await bootstrapRoles(client, opts.passwords);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    if (opts.seedTenants) await seed(client, opts.seedTenants);
  } finally {
    await client.end();
  }
}
