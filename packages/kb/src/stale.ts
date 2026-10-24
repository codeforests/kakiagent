import { sql, type ZoneDb } from '@kaki/db';

export interface StaleScanRow {
  tenantId: string;
  flagged: number;
  closed: number;
}

/**
 * The daily stale-fact scan (KB-17; FEAT-018 §4, D1): `kb_stale_scan()` flags overdue
 * approved facts as `stale` corrections and closes items whose fact moved on. Runs on the
 * outbox zone, which may only execute the function. One row per tenant with a change.
 */
export async function runStaleScan(zdb: ZoneDb): Promise<StaleScanRow[]> {
  const res = await zdb.db.execute<{ tenant_id: string; flagged: number; closed: number }>(
    sql`select tenant_id, flagged, closed from kb_stale_scan()`,
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    flagged: Number(r.flagged),
    closed: Number(r.closed),
  }));
}
