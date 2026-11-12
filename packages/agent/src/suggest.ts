import { randomUUID } from 'node:crypto';
import { rulesInForce } from '@kaki/approvals';
import { withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import {
  ConversationNotFoundError,
  getConversation,
  latestVisitorMessage,
  NotOwnerError,
  ownerOf,
  storeSuggestion,
  suggestionRetryAfter,
  type SuggestionOutcome,
  type SuggestionRow,
} from '@kaki/inbox';
import { coachingKb, searchCoachingFacts, type CoachingFact } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import { openStatus, visitorTenantState } from '@kaki/tenancy';
import { applyBoundary, triageTail } from './boundary.js';
import { answerStep, type AnswerMeta, type CoachOutcome } from './coach.js';
import { dispatchPlan } from './dispatch.js';
import { replyLanguage } from './language.js';
import { loadConversationHistory } from './memory-store.js';
import { webContextOf } from './web-context.js';
import { triage, type TurnPlan } from './plan.js';
import { replayContext, replayRegistry, ReplayPorts } from './replay-dispatch.js';

/**
 * AI-suggested replies for staff (INB-03, UC-23 4; FEAT-045 §5.1). The visitor's latest
 * message is answered exactly as a visitor turn would answer it (triage, approved facts,
 * slot render, verifier, leak and boundary guards: `answerStep`), but the draft is stored as
 * a `suggestions` row for the owner's composer, never as a message, and nothing is
 * published. A draft that fails the checks is never stored as text (`no_checked_answer`).
 * Runs synchronously in the API, like replay (D1).
 */

export interface SuggestDeps {
  /** The dashboard trust zone. */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** Wall time, for opening hours and the rate limit. */
  clock?: () => Date;
  channelLive?: () => Promise<boolean>;
}

export interface SuggestInput {
  tenantId: string;
  conversationId: string;
  /** The staff member asking; must own the conversation. */
  userId: string;
}

/** The AI is paused (GOV-08, D9): no drafts either. */
export class SuggestPausedError extends Error {}
/** The conversation has no visitor message to answer. */
export class NothingToAnswerError extends Error {}
/** D5: too many suggestions for this conversation in the last hour. */
export class TooManySuggestionsError extends Error {
  constructor(readonly retryAfterS: number) {
    super('too many suggestions');
  }
}

/** A suggestion's outcome from the answer's (§5.1 step 4). */
export function suggestionOutcome(outcome: CoachOutcome | 'none'): SuggestionOutcome {
  switch (outcome) {
    case 'answered':
      return 'ready';
    case 'escalated':
    case 'unsure':
    case 'out_of_scope':
    case 'refused':
    case 'ended':
      return 'no_checked_answer';
    case 'unavailable':
    case 'none':
      return 'unavailable';
  }
}

async function prepare(deps: SuggestDeps, input: SuggestInput, now: Date) {
  const { tenantId, conversationId, userId } = input;
  return withTenant(deps.zdb, tenantId, async (tx) => {
    const conversation = await getConversation(tx, tenantId, conversationId);
    if (!conversation) throw new ConversationNotFoundError('conversation not found');
    const owner = await ownerOf(tx, tenantId, conversationId);
    if (owner?.userId !== userId) throw new NotOwnerError(conversation);
    const tenant = await visitorTenantState(tx);
    if (!tenant) throw new Error('suggest: tenant state missing');
    if (tenant.aiPaused) throw new SuggestPausedError('the assistant is paused');
    const question = await latestVisitorMessage(tx, tenantId, conversationId);
    if (!question) throw new NothingToAnswerError('no visitor message');
    const wait = await suggestionRetryAfter(tx, tenantId, conversationId, now);
    if (wait > 0) throw new TooManySuggestionsError(wait);
    const { rules } = await rulesInForce(tx, tenantId);
    // D4: today's hours, as the AI would answer now.
    const status = tenant.hours
      ? openStatus(tenant.hours, tenant.openOnPublicHolidays, now, tenant.holidays)
      : null;
    const hours =
      tenant.hours && status
        ? {
            hours: tenant.hours,
            openOnPublicHolidays: tenant.openOnPublicHolidays,
            status,
            now,
          }
        : null;
    // D4: the thread up to the latest question; AI and staff replies are both the assistant's.
    // FEAT-026 §5.4: the memory as of this question and the messages after it.
    const loaded = await loadConversationHistory(tx, {
      tenantId,
      conversationId,
      upToSeq: question.seq,
    });
    const history = loaded.messages
      .filter((m) => m.author !== 'system')
      .map((m) => ({
        role: m.author === 'visitor' ? ('user' as const) : ('assistant' as const),
        content: m.body,
      }));
    // FEAT-029 §5.5: the web context as of this question (the sidebar's scope, D7).
    const web = await webContextOf(tx, { tenantId, conversationId, upToSeq: question.seq });
    return { tenant, rules, hours, history, question, memory: loaded.memory, web };
  });
}

/**
 * One suggestion for the conversation's latest visitor message (§5.1). Throws
 * `ConversationNotFoundError`, `NotOwnerError`, `SuggestPausedError`, `NothingToAnswerError`
 * or `TooManySuggestionsError`; every other failure is a stored `unavailable` row.
 */
export async function suggestReply(deps: SuggestDeps, input: SuggestInput): Promise<SuggestionRow> {
  const now = (deps.clock ?? (() => new Date()))();
  const prep = await prepare(deps, input, now);
  const { tenantId, conversationId, userId } = input;
  const id = randomUUID();
  const text = prep.question.body;
  // D2: metered on the conversation, so the per-conversation cost governor sees it.
  const meta: AnswerMeta = { tenantId, conversationId, turnId: id };

  const [p, f] = await Promise.allSettled([
    triage(deps.llm, {
      history: prep.history,
      meta,
      tail: triageTail(prep.rules, prep.memory, prep.web.currentPage),
    }),
    search(deps, input, id, text),
  ]);
  const plan: TurnPlan | null =
    p.status === 'fulfilled' ? applyBoundary(p.value, prep.rules, text).plan : null;
  const facts = f.status === 'fulfilled' ? f.value : null;

  // No side effects: the replay registry's stubbed ports (ADR-025); nobody is escalated,
  // flagged or captured as a lead by a draft.
  const ctx = replayContext({
    tenantId,
    sessionId: conversationId,
    turnId: id,
    ports: new ReplayPorts(0),
    rules: prep.rules,
  });
  const dispatch = plan && facts ? await dispatchPlan(replayRegistry, plan, ctx) : null;

  let outcome: SuggestionOutcome;
  let body: string | null = null;
  let factIds: string[] = [];
  let route: string | null = null;
  let language: 'en' | 'zh' = replyLanguage(plan, text);
  if (dispatch?.endTurn) {
    // A crisis or abuse turn: staff answer it themselves; the AI's fixed text isn't a draft.
    outcome = 'no_checked_answer';
  } else {
    const a = await answerStep(
      deps,
      meta,
      prep,
      text,
      prep.history,
      plan,
      facts,
      dispatch,
      prep.memory,
      prep.web,
    );
    outcome = plan && facts && dispatch ? suggestionOutcome(a.outcome) : 'unavailable';
    if (outcome === 'ready') {
      body = a.body;
      factIds = a.factIds;
    }
    route = a.explainer.route;
    language = replyLanguage(a.plan, text);
  }

  return withTenant(deps.zdb, tenantId, async (tx) => {
    const row = await storeSuggestion(tx, {
      tenantId,
      id,
      conversationId,
      forMessageId: prep.question.id,
      requestedBy: userId,
      outcome,
      body,
      factIds,
      language,
    });
    await audit.append(tx, tenantId, {
      action: 'inbox.suggestion.created',
      actorType: 'user',
      actorId: userId,
      subjectType: 'conversation',
      subjectId: conversationId,
      related: [
        { type: 'suggestion', id },
        { type: 'message', id: prep.question.id },
      ],
      payload: {
        suggestionId: auditId(id),
        outcome: auditCode(outcome),
        tasks: (plan?.tasks ?? []).map((t) => auditCode(t.kind)),
        factIds: row.factIds.map(auditId),
        route: route ? auditCode(route) : null,
      },
    });
    return row;
  });
}

/** Approved, in-date facts only (D3: the `visitor_facts` filter), from the dashboard zone. */
async function search(
  deps: SuggestDeps,
  input: SuggestInput,
  suggestionId: string,
  text: string,
): Promise<CoachingFact[]> {
  const meta = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    turnId: suggestionId,
  };
  const { vectors } = await deps.llm.embed({ texts: [text], purpose: 'query', meta });
  return withTenant(deps.zdb, input.tenantId, (tx) =>
    searchCoachingFacts(
      // The coaching context only carries IDs; a suggestion has no session of its own.
      coachingKb(tx, input.tenantId, input.userId, suggestionId),
      vectors[0]!,
      { includeUnreviewed: false },
    ),
  );
}
