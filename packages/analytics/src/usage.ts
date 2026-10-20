import { schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import type { UsageEvent, UsageSink } from '@kaki/llm-gateway';

/** Appends one ledger row in the tenant's transaction (ADR-021). RLS checks the tenant. */
async function record(tx: Tx, e: UsageEvent): Promise<void> {
  await tx.insert(schema.usageEvents).values({
    tenantId: e.tenantId,
    conversationId: e.conversationId,
    turnId: e.turnId,
    purpose: e.purpose,
    model: e.model,
    provider: e.provider,
    providerModelId: e.providerModelId,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadInputTokens: e.cacheReadInputTokens,
    cacheWriteInputTokens: e.cacheWriteInputTokens,
    costUsd: e.costUsd,
  });
}

export const usage = { record };

/**
 * The gateway's usage sink for a role (FEAT-004 D7, D11): each call is recorded in its
 * own short transaction. A failed insert is logged, never thrown, so a ledger outage
 * does not fail a visitor turn (NFR-04).
 */
export function usageSink(
  zdb: ZoneDb,
  log: { warn: (obj: object, msg: string) => void },
): UsageSink {
  return async (e) => {
    try {
      await withTenant(zdb, e.tenantId, (tx) => record(tx, e));
    } catch (err) {
      log.warn(
        { err, tenantId: e.tenantId, conversationId: e.conversationId, purpose: e.purpose },
        'usage event not recorded',
      );
    }
  };
}

export interface GovernorConfig {
  /** Raise a step above this average per conversation (ADR-007 decision 3: S$0.025). */
  targetSgd: number;
  /** Lower a step below this, a week after the last change (D9: S$0.020). */
  relaxSgd: number;
  /** ADR-007's conservative rate. */
  usdToSgd: number;
  /** Fewer conversations in the 7-day window are too few to average (D9). */
  minConversations: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  targetSgd: 0.025,
  relaxSgd: 0.02,
  usdToSgd: 1.35,
  minConversations: 20,
};

export interface GovernorChange {
  tenantId: string;
  oldStep: number;
  newStep: number;
  avgSgd: number;
  conversations: number;
}

/**
 * The cost governor (ADR-007 decision 3; FEAT-004 D9), run by scheduler-worker on the
 * outbox zone through `cost_governor_evaluate`, which sees every tenant's ledger.
 */
export async function runCostGovernor(
  zdb: ZoneDb,
  cfg: GovernorConfig = DEFAULT_GOVERNOR,
): Promise<GovernorChange[]> {
  const res = await zdb.db.execute<{
    tenant_id: string;
    old_step: number;
    new_step: number;
    avg_usd: string;
    conversations: string;
  }>(
    sql`select tenant_id, old_step, new_step, avg_usd, conversations
        from cost_governor_evaluate(${cfg.targetSgd / cfg.usdToSgd}, ${cfg.relaxSgd / cfg.usdToSgd}, ${cfg.minConversations})`,
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    oldStep: Number(r.old_step),
    newStep: Number(r.new_step),
    avgSgd: Math.round(Number(r.avg_usd) * cfg.usdToSgd * 1e6) / 1e6,
    conversations: Number(r.conversations),
  }));
}
