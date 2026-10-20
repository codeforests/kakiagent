import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Database trust zones (ADR-005). Each connects as its own login role, none of which
 * owns a table or has BYPASSRLS:
 * - `dashboard`: authenticated dashboard requests and the inbox WebSocket;
 * - `visitor`: the widget API, the agent worker and the widget SSE stream (ADR-009);
 * - `outbox`: the outbox dispatcher, which reads pending rows across tenants;
 * - `identity`: sign-in, sessions and workspace creation, before any tenant context
 *   exists (FEAT-005 D2).
 */
export type TrustZone = 'dashboard' | 'visitor' | 'outbox' | 'identity';

export interface ZoneDb {
  zone: TrustZone;
  db: Db;
  pool: pg.Pool;
}

export function createZoneDb(zone: TrustZone, connectionString: string, max = 10): ZoneDb {
  const pool = new pg.Pool({ connectionString, max, application_name: `kaki-${zone}` });
  return { zone, pool, db: drizzle(pool, { schema }) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction with `app.tenant_id` set via `SET LOCAL` (ADR-005). The
 * tenant ID must come from a trusted source only: the dashboard session, a verified
 * visitor token, a verified channel credential, or an outbox message we wrote.
 * Without it, the RLS policies match nothing (fail closed).
 */
export async function withTenant<T>(
  zdb: ZoneDb,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  return zdb.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export async function ping(zdb: ZoneDb): Promise<boolean> {
  const res = await zdb.pool.query('select 1 as ok');
  return res.rows[0]?.ok === 1;
}
