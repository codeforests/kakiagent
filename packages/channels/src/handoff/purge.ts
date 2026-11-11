import { sql, type ZoneDb } from '@kaki/db';

/**
 * ADR-015 retention (FEAT-038 §5.9; AC-10): deletes every tenant's handoff links 7 days past
 * expiry through the SECURITY DEFINER `handoff_links_purge()`, which only the scheduler's
 * `outbox` zone may run. Returns how many were deleted.
 */
export async function purgeHandoffLinks(zdb: ZoneDb): Promise<number> {
  const res = await zdb.db.execute<{ n: number }>(sql`select handoff_links_purge() as n`);
  return Number(res.rows[0]?.n ?? 0);
}
