import { sql, type ZoneDb } from '@kaki/db';

/**
 * Retention (FEAT-029 §5.9, D6; AC-9): deletes every tenant's page events past 180 days and
 * tracking choices past 13 months through the SECURITY DEFINER `visitor_events_purge()`, which
 * only the scheduler's `outbox` zone may run. Returns how many rows were deleted.
 */
export async function purgeVisitorEvents(zdb: ZoneDb): Promise<number> {
  const res = await zdb.db.execute<{ n: number }>(sql`select visitor_events_purge() as n`);
  return Number(res.rows[0]?.n ?? 0);
}
