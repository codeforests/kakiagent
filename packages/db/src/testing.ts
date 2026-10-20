import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createZoneDb, type TrustZone, type ZoneDb } from './client.js';
import { devTenants, LOGIN_ROLES, setupDatabase, type LoginRole } from './setup.js';

/** Same image and major version as local compose and Aurora (ADR-004): Postgres 16 + pgvector. */
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

export const TENANT_A = devTenants([])[0]!.id;
export const TENANT_B = devTenants([])[1]!.id;

export interface TestDatabase {
  /** Null when `KAKI_TEST_DATABASE_URL` points the suite at an existing server. */
  container: StartedPostgreSqlContainer | null;
  ownerUrl: string;
  zone(zone: TrustZone): ZoneDb;
  urlFor(role: LoginRole): string;
  stop(): Promise<void>;
}

const ZONE_ROLE: Record<TrustZone, LoginRole> = {
  dashboard: 'app_dashboard',
  visitor: 'app_agent_visitor',
  outbox: 'app_outbox',
  identity: 'app_identity',
};

/**
 * Without Docker, `KAKI_TEST_DATABASE_URL` (a superuser URL on a Postgres 16 server with
 * pgvector) runs each suite in a fresh database on that server instead of a container.
 * Login roles are cluster-wide, so run packages one at a time (`--concurrency=1`).
 */
async function startExternal(serverUrl: string) {
  const name = `kaki_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(serverUrl);
  u.pathname = `/${name}`;
  return {
    ownerUrl: u.toString(),
    async stop() {
      const c = new pg.Client({ connectionString: serverUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

/** Starts Postgres in a container and runs the real setup: roles, migrations, two seeded tenants. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const external = process.env.KAKI_TEST_DATABASE_URL;
  const container = external
    ? null
    : await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('kakiagent')
        .withUsername('kaki_owner')
        .withPassword('owner-test-password')
        .start();
  const ext = external ? await startExternal(external) : null;
  const ownerUrl = container ? container.getConnectionUri() : ext!.ownerUrl;
  const passwords = Object.fromEntries(LOGIN_ROLES.map((r) => [r, `${r}-test-password`])) as Record<
    LoginRole,
    string
  >;
  await setupDatabase({ ownerUrl, passwords, seedTenants: devTenants(['http://localhost:5175']) });

  const urlFor = (role: LoginRole) => {
    const u = new URL(ownerUrl);
    u.username = role;
    u.password = passwords[role];
    return u.toString();
  };
  const zones = new Map<TrustZone, ZoneDb>();
  return {
    container,
    ownerUrl,
    urlFor,
    zone(zone) {
      let z = zones.get(zone);
      if (!z) {
        z = createZoneDb(zone, urlFor(ZONE_ROLE[zone]), 4);
        zones.set(zone, z);
      }
      return z;
    },
    async stop() {
      await Promise.all([...zones.values()].map((z) => z.pool.end()));
      if (container) await container.stop();
      else await ext!.stop();
    },
  };
}
