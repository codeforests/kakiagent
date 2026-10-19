import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createZoneDb, type TrustZone, type ZoneDb } from './client.js';
import { devTenants, LOGIN_ROLES, setupDatabase, type LoginRole } from './setup.js';

/** Same image and major version as local compose and Aurora (ADR-004): Postgres 16 + pgvector. */
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

export const TENANT_A = devTenants([])[0]!.id;
export const TENANT_B = devTenants([])[1]!.id;

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  ownerUrl: string;
  zone(zone: TrustZone): ZoneDb;
  urlFor(role: LoginRole): string;
  stop(): Promise<void>;
}

const ZONE_ROLE: Record<TrustZone, LoginRole> = {
  dashboard: 'app_dashboard',
  visitor: 'app_agent_visitor',
  outbox: 'app_outbox',
};

/** Starts Postgres in a container and runs the real setup: roles, migrations, two seeded tenants. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('kakiagent')
    .withUsername('kaki_owner')
    .withPassword('owner-test-password')
    .start();
  const ownerUrl = container.getConnectionUri();
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
      await container.stop();
    },
  };
}
