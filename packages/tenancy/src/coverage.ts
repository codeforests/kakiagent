import { sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import type { Industry } from './profile.js';
import { INDUSTRY_TEMPLATES, type IndustryTemplate } from './templates.js';

/** 404 `not_found`: no such topic in the tenant's industry template (FEAT-019 §3). */
export class UnknownTopicError extends Error {}

/** The tenant's industry and its template, or null when it has none (ONB-06). */
export async function coverageTemplate(
  tx: Tx,
  tenantId: string,
): Promise<{ industry: Industry; template: IndustryTemplate } | null> {
  const res = await tx.execute<{ industry: string | null }>(
    sql`select industry from business_profiles where tenant_id = ${tenantId}`,
  );
  const industry = res.rows[0]?.industry as Industry | null | undefined;
  const template = industry ? INDUSTRY_TEMPLATES[industry] : undefined;
  return industry && template ? { industry, template } : null;
}

/** Template topic IDs the owner marked "Doesn't apply" (KB-09; FEAT-019 D8). */
export async function coverageSkippedTopics(tx: Tx, tenantId: string): Promise<string[]> {
  const res = await tx.execute<{ skipped: string[] }>(
    sql`select coverage_skipped_topics as skipped from business_profiles where tenant_id = ${tenantId}`,
  );
  return res.rows[0]?.skipped ?? [];
}

/**
 * Marks a template topic "Doesn't apply", or takes the mark off (D8). The topic must be in
 * the tenant's template, else `UnknownTopicError`. Audited with the topic ID only. Returns
 * the skip list as saved.
 */
export async function setTopicSkipped(
  tx: Tx,
  input: { tenantId: string; userId: string; topicId: string; skipped: boolean },
): Promise<string[]> {
  const found = await coverageTemplate(tx, input.tenantId);
  if (!found?.template.suggestedFaqs.some((f) => f.id === input.topicId))
    throw new UnknownTopicError('no such topic');
  const res = await tx.execute<{ skipped: string[] }>(sql`
    update business_profiles set coverage_skipped_topics = ${
      input.skipped
        ? sql`array_append(array_remove(coverage_skipped_topics, ${input.topicId}::text), ${input.topicId}::text)`
        : sql`array_remove(coverage_skipped_topics, ${input.topicId}::text)`
    }
    where tenant_id = ${input.tenantId}
    returning coverage_skipped_topics as skipped`);
  await audit.append(tx, input.tenantId, {
    action: input.skipped ? 'coverage.topic_skipped' : 'coverage.topic_unskipped',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'tenant',
    subjectId: input.tenantId,
    payload: { topic: auditCode(input.topicId) },
  });
  return res.rows[0]?.skipped ?? [];
}
