import { withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import {
  getConversation,
  getMessage,
  listAskedConversations,
  messagesSince,
  recentMessages,
  visitorMessageCount,
  type ConversationRow,
  type MessageRow,
} from '@kaki/inbox';
import { coachingKb, searchCoachingFacts, type CoachingFact } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import { openStatus, visitorTenantState, type VisitorTenantState } from '@kaki/tenancy';
import { answerStep, explain, type CoachOutcome, type Explainer } from './coach.js';
import {
  CoachingSessionNotFoundError,
  createReplaySession,
  getSession,
  insertReplayMessage,
  lastReplays,
  replayMessages,
  type CoachingMessageRow,
  type CoachingSessionRow,
} from './coach-store.js';
import { dispatchPlan } from './dispatch.js';
import type { HoursContext } from './hours-text.js';
import { replyLanguage } from './language.js';
import { triage, type TurnPlan } from './plan.js';
import { HISTORY_LIMIT, type HistoryMessage } from './prompt.js';
import {
  abuseTurns,
  effectsOf,
  replayContext,
  ReplayPorts,
  replayRegistry,
  type ReplayEffect,
} from './replay-dispatch.js';
import { safetyText, textsFor } from './texts.js';

/**
 * Replay (AGT-17, UC-04 4b; FEAT-028 §5.1, ADR-027): a real past conversation asked
 * again, question by question, against the current KB and hours (D4), each against the
 * original history (D3), one question per request in the api (D1). Visitor triage, the
 * coaching search and the verified answer step; every dispatch port is stubbed, so
 * nothing is flagged, sent or created (ADR-025 decision 7). Visitor text is read from
 * `messages`, never copied (D7).
 */

/** The first 20 questions of a conversation are replayed (D5, KB-18's bound). */
export const REPLAY_LIMIT = 20;
export const CANDIDATES_PAGE = 20;
const FIRST_QUESTION_MAX = 120;

export class ReplayConversationNotFoundError extends Error {}
export class NothingToReplayError extends Error {}
export class ReplayCompleteError extends Error {}
/** The conversation or the question was erased after the replay started (ADR-015). */
export class ConversationGoneError extends Error {}
export class InvalidReplayCursorError extends Error {}

export interface ReplayDeps {
  /** The dashboard trust zone. */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** Wall time, for opening hours. */
  clock?: () => Date;
  channelLive?: () => Promise<boolean>;
}

export interface ReplayCandidateRow {
  conversation: ConversationRow;
  firstQuestion: string;
  questions: number;
  lastReplayId: string | null;
}

export interface OriginalReplyRow {
  author: 'agent' | 'staff' | 'system';
  text: string;
  factIds: string[];
  createdAt: Date;
}

export interface ReplayTurnRow {
  messageId: string;
  index: number;
  question: string;
  askedAt: Date;
  original: OriginalReplyRow[];
  replayed: CoachingMessageRow | null;
  effects: ReplayEffect[];
  factsChanged: boolean | null;
}

export interface ReplayView {
  session: CoachingSessionRow;
  conversationId: string;
  totalQuestions: number;
  turns: ReplayTurnRow[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(c: ConversationRow): string {
  return Buffer.from(`${c.lastMessageAt.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { lastMessageAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(ts ?? '');
  if (!id || !UUID.test(id) || Number.isNaN(date.getTime()))
    throw new InvalidReplayCursorError('bad cursor');
  return { lastMessageAt: date, id };
}

/** Conversations with a visitor message, newest first, 20 a page (AC-2). */
export async function replayCandidates(
  deps: Pick<ReplayDeps, 'zdb'>,
  input: { tenantId: string; cursor?: string },
): Promise<{ conversations: ReplayCandidateRow[]; nextCursor: string | null }> {
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;
  return withTenant(deps.zdb, input.tenantId, async (tx) => {
    const rows = await listAskedConversations(tx, input.tenantId, {
      ...(after ? { after } : {}),
      limit: CANDIDATES_PAGE + 1,
    });
    const page = rows.slice(0, CANDIDATES_PAGE);
    const last = await lastReplays(
      tx,
      input.tenantId,
      page.map((r) => r.conversation.id),
    );
    return {
      conversations: page.map((r) => ({
        conversation: r.conversation,
        firstQuestion: r.firstQuestion.slice(0, FIRST_QUESTION_MAX),
        questions: r.questions,
        lastReplayId: last.get(r.conversation.id) ?? null,
      })),
      nextCursor: rows.length > CANDIDATES_PAGE ? encodeCursor(page.at(-1)!.conversation) : null,
    };
  });
}

/** The conversation's questions, each with the replies that followed it, oldest first. */
function questionsOf(messages: MessageRow[]) {
  const out: { message: MessageRow; original: OriginalReplyRow[] }[] = [];
  for (const m of messages) {
    if (m.author === 'visitor') out.push({ message: m, original: [] });
    else
      out.at(-1)?.original.push({
        author: m.author,
        text: m.body,
        factIds: m.factIds,
        createdAt: m.createdAt,
      });
  }
  return out;
}

const sameSet = (a: string[], b: string[]) =>
  new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

const storedEffects = (row: CoachingMessageRow): ReplayEffect[] =>
  ((row.explainer as { effects?: ReplayEffect[] } | null)?.effects ?? []).map((e) => ({
    task: e.task,
    outcome: e.outcome,
  }));

async function loadReplay(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  sessionId: string,
): Promise<ReplayView> {
  const session = await getSession(tx, tenantId, sessionId);
  if (!session || session.origin !== 'replay' || !session.replayConversationId)
    throw new CoachingSessionNotFoundError('replay not found');
  const conversationId = session.replayConversationId;
  const messages = await messagesSince(tx, { tenantId, conversationId, afterSeq: 0 });
  const totalQuestions = await visitorMessageCount(tx, tenantId, conversationId);
  const stored = new Map(
    (await replayMessages(tx, tenantId, sessionId)).map((r) => [r.replayOf!, r]),
  );
  const turns = questionsOf(messages)
    .slice(0, REPLAY_LIMIT)
    .map(({ message, original }, index): ReplayTurnRow => {
      const replayed = stored.get(message.id) ?? null;
      const firstAgent = original.find((o) => o.author === 'agent');
      return {
        messageId: message.id,
        index,
        question: message.body,
        askedAt: message.createdAt,
        original,
        replayed,
        effects: replayed ? storedEffects(replayed) : [],
        factsChanged:
          replayed && firstAgent ? !sameSet(replayed.factIds, firstAgent.factIds) : null,
      };
    });
  return { session, conversationId, totalQuestions, turns };
}

/** A replay with its turns: the first 20 questions and what each got then and now (AC-2). */
export async function getReplay(
  deps: Pick<ReplayDeps, 'zdb'>,
  input: { tenantId: string; sessionId: string },
): Promise<ReplayView> {
  return withTenant(deps.zdb, input.tenantId, (tx) =>
    loadReplay(tx, input.tenantId, input.sessionId),
  );
}

/** Starts a replay of a conversation; every turn pending (AC-2, AC-9). */
export async function startReplay(
  deps: Pick<ReplayDeps, 'zdb'>,
  input: { tenantId: string; userId: string; conversationId: string; includeUnreviewed: boolean },
): Promise<ReplayView> {
  const { tenantId } = input;
  return withTenant(deps.zdb, tenantId, async (tx) => {
    const conversation = UUID.test(input.conversationId)
      ? await getConversation(tx, tenantId, input.conversationId)
      : null;
    if (!conversation) throw new ReplayConversationNotFoundError('conversation not found');
    const questions = await visitorMessageCount(tx, tenantId, conversation.id);
    if (!questions) throw new NothingToReplayError('no visitor message');
    const session = await createReplaySession(tx, {
      tenantId,
      userId: input.userId,
      conversationId: conversation.id,
      includeUnreviewed: input.includeUnreviewed,
    });
    await audit.append(tx, tenantId, {
      action: 'coach.replay.started',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'coaching_session',
      subjectId: session.id,
      related: [{ type: 'conversation', id: conversation.id }],
      payload: { conversationId: auditId(conversation.id), questions },
    });
    return loadReplay(tx, tenantId, session.id);
  });
}

export interface ReplayQuestionInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  conversationId: string;
  /** The original visitor message. */
  messageId: string;
  includeUnreviewed: boolean;
}

interface ReplayPrep {
  tenant: VisitorTenantState;
  hours: HoursContext | null;
  question: MessageRow;
  history: HistoryMessage[];
  priorAbuse: number;
}

async function prepareQuestion(deps: ReplayDeps, input: ReplayQuestionInput): Promise<ReplayPrep> {
  const wall = (deps.clock ?? (() => new Date()))();
  const { tenantId } = input;
  return withTenant(deps.zdb, tenantId, async (tx) => {
    if (!(await getSession(tx, tenantId, input.sessionId)))
      throw new CoachingSessionNotFoundError('replay not found');
    const question = await getMessage(tx, tenantId, input.messageId);
    if (
      !question ||
      question.author !== 'visitor' ||
      question.conversationId !== input.conversationId ||
      !(await getConversation(tx, tenantId, input.conversationId))
    )
      throw new ConversationGoneError('conversation gone');
    const tenant = await visitorTenantState(tx);
    if (!tenant) throw new Error('replay: tenant state missing');
    // D4: today's hours, as a visitor asking now would get.
    const status = tenant.hours
      ? openStatus(tenant.hours, tenant.openOnPublicHolidays, wall, tenant.holidays)
      : null;
    const hours =
      tenant.hours && status
        ? {
            hours: tenant.hours,
            openOnPublicHolidays: tenant.openOnPublicHolidays,
            status,
            now: wall,
          }
        : null;
    // D3: the original conversation up to this question, mapped as the visitor turn maps it.
    const history = (
      await recentMessages(tx, {
        tenantId,
        conversationId: input.conversationId,
        upToSeq: question.seq,
        limit: HISTORY_LIMIT,
      })
    ).map((m) => ({
      role: m.author === 'visitor' ? ('user' as const) : ('assistant' as const),
      content: m.body,
    }));
    // The abuse count a live turn would see: this replay's earlier abuse turns.
    const earlier = (await replayMessages(tx, tenantId, input.sessionId)).filter(
      (r) => r.replayOf !== question.id,
    );
    const seqs = new Map<string, number>();
    for (const r of earlier) {
      const m = await getMessage(tx, tenantId, r.replayOf!);
      if (m) seqs.set(r.replayOf!, m.seq);
    }
    const priorAbuse = abuseTurns(
      earlier.filter((r) => (seqs.get(r.replayOf!) ?? Infinity) < question.seq).map(storedEffects),
    );
    return { tenant, hours, question, history, priorAbuse };
  });
}

async function search(
  deps: ReplayDeps,
  input: ReplayQuestionInput,
  text: string,
): Promise<CoachingFact[]> {
  const meta = { tenantId: input.tenantId, coachingSessionId: input.sessionId };
  const { vectors } = await deps.llm.embed({ texts: [text], purpose: 'query', meta });
  return withTenant(deps.zdb, input.tenantId, (tx) =>
    searchCoachingFacts(
      coachingKb(tx, input.tenantId, input.userId, input.sessionId),
      vectors[0]!,
      { includeUnreviewed: input.includeUnreviewed },
    ),
  );
}

/**
 * One past question asked again (FEAT-028 §5.1 step 1–4; D8: FEAT-018 reuses it). Stores
 * the answer once per question and returns the stored row.
 */
export async function replayQuestion(
  deps: ReplayDeps,
  input: ReplayQuestionInput,
): Promise<{ row: CoachingMessageRow; effects: ReplayEffect[] }> {
  const prep = await prepareQuestion(deps, input);
  const text = prep.question.body;
  const meta = { tenantId: input.tenantId, coachingSessionId: input.sessionId };
  // The live visitor triage prompt, not coaching's (D3).
  const [p, f] = await Promise.allSettled([
    triage(deps.llm, { history: prep.history, meta }),
    search(deps, input, text),
  ]);
  const plan: TurnPlan | null = p.status === 'fulfilled' ? p.value : null;
  const facts = f.status === 'fulfilled' ? f.value : null;

  const ports = new ReplayPorts(prep.priorAbuse);
  const ctx = replayContext({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    turnId: prep.question.id,
    ports,
  });
  const dispatch = plan && facts ? await dispatchPlan(replayRegistry, plan, ctx) : null;
  const effects = effectsOf(dispatch?.reports ?? []);

  let body: string;
  let outcome: CoachOutcome;
  let factIds: string[];
  let explainer: Explainer;
  if (plan && facts && dispatch?.endTurn) {
    const persona = prep.tenant.persona;
    const t = textsFor(replyLanguage(plan, text), persona);
    body = safetyText(t, dispatch.endTurn.key, prep.tenant.businessName);
    outcome = 'ended';
    factIds = [];
    explainer = explain({
      plan,
      safety: dispatch.endTurn.key,
      facts,
      answer: null,
      outcome,
      replies: dispatch.replies,
      route: null,
      minConfidence: prep.tenant.routePolicy.minConfidence,
      aiPaused: prep.tenant.aiPaused,
      channelLive: deps.channelLive ? await deps.channelLive() : true,
    });
  } else {
    const a = await answerStep(deps, input, prep, text, prep.history, plan, facts, dispatch);
    ({ body, outcome, factIds, explainer } = a);
  }

  const row = await withTenant(deps.zdb, input.tenantId, async (tx) => {
    const stored = await insertReplayMessage(tx, {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      message: {
        replayOf: prep.question.id,
        body,
        includeUnreviewed: input.includeUnreviewed,
        outcome,
        factIds,
        explainer: { ...explainer, effects },
      },
    });
    await audit.append(tx, input.tenantId, {
      action: 'coach.replay.turn',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'coaching_session',
      subjectId: input.sessionId,
      related: [
        { type: 'coaching_message', id: stored.id },
        { type: 'message', id: prep.question.id },
      ],
      payload: {
        outcome: auditCode(outcome),
        tasks: (plan?.tasks ?? []).map((t) => auditCode(t.kind)),
        factIds: factIds.map(auditId),
        effects: effects.map((e) => auditCode(`${e.task}:${e.outcome}`)),
      },
    });
    return stored;
  });
  return { row, effects: storedEffects(row) };
}

/** Answers the lowest pending turn (AC-7); 409 when none is left. */
export async function replayNext(
  deps: ReplayDeps,
  input: { tenantId: string; userId: string; sessionId: string },
): Promise<{ turn: ReplayTurnRow; remaining: number }> {
  const before = await getReplay(deps, input);
  // A replay starts with a question; none left means the conversation was erased (ADR-015).
  if (!before.totalQuestions) throw new ConversationGoneError('conversation gone');
  const pending = before.turns.find((t) => !t.replayed);
  if (!pending) throw new ReplayCompleteError('replay complete');
  await replayQuestion(deps, {
    ...input,
    conversationId: before.conversationId,
    messageId: pending.messageId,
    includeUnreviewed: before.session.includeUnreviewed,
  });
  const after = await getReplay(deps, input);
  const turn = after.turns.find((t) => t.messageId === pending.messageId);
  if (!turn) throw new ConversationGoneError('conversation gone');
  return { turn, remaining: after.turns.filter((t) => !t.replayed).length };
}
