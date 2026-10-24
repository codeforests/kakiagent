import { withTenant } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import { getMessage, pastQuestionsUsing } from '@kaki/inbox';
import { effectiveChange, getCorrection } from '@kaki/kb';
import {
  correctionReplaySession,
  createCorrectionReplaySession,
  replayMessages,
  type CoachingMessageRow,
  type CoachingSessionRow,
} from './coach-store.js';
import type { ReplayEffect } from './replay-dispatch.js';
import {
  originalRepliesFor,
  REPLAY_LIMIT,
  ReplayCompleteError,
  replayQuestion,
  storedEffects,
  type OriginalReplyRow,
  type ReplayDeps,
} from './replay.js';

/**
 * Old-versus-new replay after a correction (KB-18 "re-runs up to 20 past questions that
 * used the changed facts", UC-16 4; FEAT-018 §5.4). The questions are fixed at acceptance
 * (D4): the newest 20 asked before the decision whose agent reply cited a corrected fact.
 * Each is asked again through FEAT-028's `replayQuestion`, approved facts only (D5).
 * Only accepted fact edits replay (D3).
 */

export class CorrectionReplayNotFoundError extends Error {}

export interface CorrectionReplayTurnRow {
  messageId: string;
  conversationId: string;
  index: number;
  question: string;
  askedAt: Date;
  original: OriginalReplyRow[];
  replayed: CoachingMessageRow | null;
  effects: ReplayEffect[];
  answerChanged: boolean | null;
}

export interface CorrectionReplayView {
  session: CoachingSessionRow;
  status: 'replaying' | 'complete';
  matched: number;
  turns: CorrectionReplayTurnRow[];
}

const normalised = (s: string) => s.replace(/\s+/g, ' ').trim();

async function loadCorrectionReplay(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  session: CoachingSessionRow,
): Promise<CorrectionReplayView> {
  const stored = new Map(
    (await replayMessages(tx, tenantId, session.id)).map((r) => [r.replayOf!, r]),
  );
  const turns: CorrectionReplayTurnRow[] = [];
  for (const id of session.replayQuestionIds) {
    // A question whose conversation was erased is left out (ADR-015).
    const q = await getMessage(tx, tenantId, id);
    if (!q || q.author !== 'visitor') continue;
    const original = await originalRepliesFor(tx, tenantId, q);
    const replayed = stored.get(q.id) ?? null;
    const firstAgent = original.find((o) => o.author === 'agent');
    turns.push({
      messageId: q.id,
      conversationId: q.conversationId,
      index: turns.length,
      question: q.body,
      askedAt: q.createdAt,
      original,
      replayed,
      effects: replayed ? storedEffects(replayed) : [],
      answerChanged:
        replayed && firstAgent ? normalised(replayed.body) !== normalised(firstAgent.text) : null,
    });
  }
  return {
    session,
    status: turns.every((t) => t.replayed) ? 'complete' : 'replaying',
    matched: session.replayMatched ?? turns.length,
    turns,
  };
}

/**
 * Starts the replay for an accepted correction whose effective change is a fact edit.
 * Idempotent: a second call returns the stored replay. Null when nothing replays (another
 * change kind, not accepted, or no past question used the fact).
 */
export async function startCorrectionReplay(
  deps: Pick<ReplayDeps, 'zdb'>,
  input: { tenantId: string; userId: string; correctionId: string },
): Promise<CorrectionReplayView | null> {
  const { tenantId } = input;
  return withTenant(deps.zdb, tenantId, async (tx) => {
    const existing = await correctionReplaySession(tx, tenantId, input.correctionId);
    if (existing) return loadCorrectionReplay(tx, tenantId, existing);
    const c = await getCorrection({ tx, tenantId }, input.correctionId);
    if (c.status !== 'accepted' && c.status !== 'edited_and_accepted') return null;
    const change = effectiveChange(c);
    if (change.kind !== 'edit_fact' || !c.decidedAt) return null;
    const { questions, matched } = await pastQuestionsUsing(tx, {
      tenantId,
      factIds: [change.factId],
      before: c.decidedAt,
      limit: REPLAY_LIMIT,
    });
    if (!questions.length) return null;
    const { session, created } = await createCorrectionReplaySession(tx, {
      tenantId,
      userId: input.userId,
      correctionId: c.id,
      questionIds: questions.map((q) => q.messageId),
      matched,
    });
    if (created)
      await audit.append(tx, tenantId, {
        action: 'correction.replay.started',
        actorType: 'user',
        actorId: input.userId,
        subjectType: 'coaching_session',
        subjectId: session.id,
        related: [{ type: 'correction', id: c.id }],
        payload: { correctionId: auditId(c.id), questions: questions.length, matched },
      });
    return loadCorrectionReplay(tx, tenantId, session);
  });
}

/** A correction's replay, or null when it has none. */
export async function getCorrectionReplay(
  deps: Pick<ReplayDeps, 'zdb'>,
  input: { tenantId: string; correctionId: string },
): Promise<CorrectionReplayView | null> {
  return withTenant(deps.zdb, input.tenantId, async (tx) => {
    const session = await correctionReplaySession(tx, input.tenantId, input.correctionId);
    return session ? loadCorrectionReplay(tx, input.tenantId, session) : null;
  });
}

/** Answers the first pending question (AC-7); `ReplayCompleteError` when none is left. */
export async function correctionReplayNext(
  deps: ReplayDeps,
  input: { tenantId: string; userId: string; correctionId: string },
): Promise<{ turn: CorrectionReplayTurnRow; remaining: number }> {
  const before = await getCorrectionReplay(deps, input);
  if (!before) throw new CorrectionReplayNotFoundError('no replay');
  const pending = before.turns.find((t) => !t.replayed);
  if (!pending) throw new ReplayCompleteError('replay complete');
  await replayQuestion(deps, {
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: before.session.id,
    conversationId: pending.conversationId,
    messageId: pending.messageId,
    includeUnreviewed: false,
  });
  const after = (await getCorrectionReplay(deps, input))!;
  const turn = after.turns.find((t) => t.messageId === pending.messageId);
  if (!turn) throw new ReplayCompleteError('question gone');
  return { turn, remaining: after.turns.filter((t) => !t.replayed).length };
}
