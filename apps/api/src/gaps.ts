import type { CorrectionContext } from '@kaki/contracts';
import type { Tx } from '@kaki/db';
import { gapCounts, gapQuestions } from '@kaki/inbox';
import type { GapStat } from '@kaki/kb';

const DAY_MS = 86_400_000;
const CONTEXT_QUESTIONS = 5;

/** Counts and the newest ask per coverage-gap item, from inbox (kb's `gapStats` port). */
export function gapStatsIn(tx: Tx, tenantId: string) {
  return async (ids: string[], since: Date): Promise<Map<string, GapStat>> => {
    const [counts, newest] = await Promise.all([
      gapCounts(tx, tenantId, ids, since),
      gapQuestions(tx, tenantId, ids, { perItem: 1 }),
    ]);
    const out = new Map<string, GapStat>();
    for (const [id, c] of counts)
      out.set(id, {
        asksSince: c.asksSince,
        asksTotal: c.asksTotal,
        firstAskedAt: c.firstAskedAt,
        lastAskedAt: c.lastAskedAt,
        reasons: c.reasons,
        newest: newest.get(id)?.[0]?.body ?? null,
      });
    return out;
  };
}

/** A gap item's counts and newest questions for the correction detail (FEAT-019 §3). */
export async function gapContext(
  tx: Tx,
  tenantId: string,
  correctionId: string,
  now = new Date(),
): Promise<CorrectionContext['gap']> {
  const [counts, questions] = await Promise.all([
    gapCounts(tx, tenantId, [correctionId], new Date(now.getTime() - 30 * DAY_MS)),
    gapQuestions(tx, tenantId, [correctionId], { perItem: CONTEXT_QUESTIONS }),
  ]);
  const c = counts.get(correctionId);
  return {
    asks30d: c?.asksSince ?? 0,
    asksTotal: c?.asksTotal ?? 0,
    lastAskedAt: c ? c.lastAskedAt.toISOString() : null,
    questions: (questions.get(correctionId) ?? []).map((q) => ({
      messageId: q.messageId,
      conversationId: q.conversationId,
      body: q.body,
      askedAt: q.askedAt.toISOString(),
      reason: q.reason,
    })),
  };
}
