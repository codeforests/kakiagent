import { sql, type ZoneDb } from '@kaki/db';

export interface GapClusterRow {
  tenantId: string;
  grouped: number;
  opened: number;
  closed: number;
}

/**
 * Gap grouping (KB-09, KB-18; FEAT-019 §4, D2): `kb_gap_cluster()` files marked questions
 * under `coverage_gap` items and closes items with no question left. Runs on the outbox
 * zone, which may only execute the function. One row per tenant with a change.
 */
export async function runGapCluster(zdb: ZoneDb): Promise<GapClusterRow[]> {
  const res = await zdb.db.execute<{
    tenant_id: string;
    grouped: number;
    opened: number;
    closed: number;
  }>(sql`select tenant_id, grouped, opened, closed from kb_gap_cluster()`);
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    grouped: Number(r.grouped),
    opened: Number(r.opened),
    closed: Number(r.closed),
  }));
}
