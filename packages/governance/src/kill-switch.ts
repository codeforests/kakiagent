import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit } from './audit.js';

const { tenants } = schema;

/**
 * The kill switch (GOV-08; FEAT-057 §5.1). `tenants.ai_paused` is what the send gate reads
 * before every turn and segment (ADR-013); this sets it on purpose, with who and when, and
 * audits the change. Run under the dashboard zone in the session tenant's transaction.
 */
export interface AiPauseState {
  paused: boolean;
  pausedAt: Date | null;
}

export async function aiPauseState(tx: Tx, tenantId: string): Promise<AiPauseState> {
  const [row] = await tx
    .select({ paused: tenants.aiPaused, pausedAt: tenants.aiPausedAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new Error('kill switch: tenant not visible');
  return row;
}

/**
 * Pause or resume. One conditional update, so a repeat or the loser of a race changes
 * nothing and writes no audit entry (D3); the winner appends `ai.paused` / `ai.resumed`
 * with IDs only (ADR-014) in the same transaction.
 */
export async function setAiPaused(
  tx: Tx,
  input: { tenantId: string; userId: string; paused: boolean },
): Promise<AiPauseState & { changed: boolean }> {
  const { tenantId, userId, paused } = input;
  const [updated] = await tx
    .update(tenants)
    .set(
      paused
        ? { aiPaused: true, aiPausedAt: sql`now()`, aiPausedBy: userId }
        : { aiPaused: false, aiPausedAt: null, aiPausedBy: null },
    )
    .where(and(eq(tenants.id, tenantId), eq(tenants.aiPaused, !paused)))
    .returning({ paused: tenants.aiPaused, pausedAt: tenants.aiPausedAt });
  if (!updated) return { changed: false, ...(await aiPauseState(tx, tenantId)) };
  await audit.append(tx, tenantId, {
    action: paused ? 'ai.paused' : 'ai.resumed',
    actorType: 'user',
    actorId: userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload: {},
  });
  return { changed: true, ...updated };
}
