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
}

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
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'second-tenant',
      name: 'Second Tenant Pte Ltd',
      widgetKey: 'wk_dev_second',
      allowedOrigins,
      gstRegistered: false,
      ownerEmail: 'owner@second-tenant.test',
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
      `insert into business_profiles (tenant_id, gst_registered) values ($1, $2)
       on conflict (tenant_id) do update set gst_registered = excluded.gst_registered, updated_at = now()`,
      [t.id, t.gstRegistered],
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
    await client.query(
      `insert into terms_acceptances (tenant_id, user_id, document, version)
       select $1, $2, d, $3 from unnest(array['tos', 'aup', 'dpa']) as d
       where not exists (select 1 from terms_acceptances where tenant_id = $1 and version = $3)`,
      [t.id, userId, SEED_TERMS_VERSION],
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
