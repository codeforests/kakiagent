import { schema, sql, type Tx } from '@kaki/db';
import { audit } from '@kaki/governance';
import { z } from 'zod';

const Months = z.int().min(1).max(24);
/**
 * Months before an approved fact of each type is due for re-confirmation (KB-17;
 * FEAT-018 §5.2, D6). Read by the stale scan in SQL; edited from the Corrections screen.
 */
export const ReviewIntervals = z
  .object({ product: Months, faq: Months, policy: Months, promotion: Months })
  .strict();
export type ReviewIntervals = z.infer<typeof ReviewIntervals>;

export async function reviewIntervals(tx: Tx, tenantId: string): Promise<ReviewIntervals> {
  const res = await tx.execute<{ m: ReviewIntervals }>(
    sql`select fact_review_months as m from tenants where id = ${tenantId}`,
  );
  return ReviewIntervals.parse(res.rows[0]?.m);
}

/** Saves the intervals; last write wins (one small settings object, no version). */
export async function saveReviewIntervals(
  tx: Tx,
  tenantId: string,
  userId: string,
  intervals: ReviewIntervals,
): Promise<ReviewIntervals> {
  const saved = ReviewIntervals.parse(intervals);
  await tx.execute(
    sql`update ${schema.tenants} set fact_review_months = ${JSON.stringify(saved)}::jsonb where id = ${tenantId}`,
  );
  await audit.append(tx, tenantId, {
    action: 'kb.review_intervals.changed',
    actorType: 'user',
    actorId: userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload: { ...saved },
  });
  return saved;
}
