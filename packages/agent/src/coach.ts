import { withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import {
  attachCorrectionMessage,
  coachingKb,
  dashboardKb,
  factLabel,
  getCorrection,
  getFact,
  InvalidCorrectionError,
  proposeCorrection,
  searchCoachingFacts,
  type CoachingFact,
  type CorrectionRecord,
  type FactRecord,
  type ProposalInput,
  type VisitorFact,
} from '@kaki/kb';
import { routeReply, type LlmGateway, type LogicalModel } from '@kaki/llm-gateway';
import { piiMask } from '@kaki/platform';
import {
  getBusinessProfile,
  openStatus,
  visitorTenantState,
  WeeklyHours,
  type VisitorTenantState,
} from '@kaki/tenancy';
import { answerTurn, type AnswerResult } from './answer.js';
import { coachingRegistry } from './coach-dispatch.js';
import { COACH_TRIAGE_SYSTEM } from './coach-prompt.js';
import {
  appendMessages,
  CoachingSessionNotFoundError,
  getMessage,
  getSession,
  sessionMessages,
  type CoachingMessageRow,
} from './coach-store.js';
import { dispatchPlan, dispatchToolCall, type DispatchContext, type ReplyKey } from './dispatch.js';
import { systemSlots, type HoursContext } from './hours-text.js';
import { replyLanguage } from './language.js';
import { routeSignals, triage, type TurnPlan } from './plan.js';
import { HISTORY_LIMIT, type HistoryMessage } from './prompt.js';
import { candidatesOf, proposeChange } from './propose.js';
import { textsFor } from './texts.js';

/**
 * Coaching (AGT-17, ONB-05; FEAT-027 §5.2, ADR-026): the owner's playground turn, run
 * synchronously in the api role (D1). Same compose, slot and verifier pipeline as a
 * visitor turn, over the coaching search; a correction becomes a proposal in the
 * corrections queue; the explainer is built in code (D3). The send gate doesn't apply
 * (D5): nothing is sent to anyone.
 */

export type CoachOutcome =
  'answered' | 'escalated' | 'out_of_scope' | 'unsure' | 'refused' | 'unavailable';
export type ReasonCode =
  | 'matched_facts'
  | 'no_matching_fact'
  | 'low_confidence'
  | 'out_of_scope'
  | 'advice'
  | 'illegal'
  | 'injection'
  | 'impersonation'
  | 'regenerated'
  | 'segment_blocked'
  | 'escalated'
  | 'hours_slot'
  | 'unreviewed_used';
export type VisitorsWouldGet = 'same' | 'without_unreviewed' | 'fallback_paused' | 'not_live';

export interface ExplainedFact {
  id: string;
  type: VisitorFact['type'];
  label: string;
  status: 'approved' | 'needs_review';
  used: boolean;
}

export interface Explainer {
  outcome: CoachOutcome;
  facts: ExplainedFact[];
  usedFactIds: string[];
  reasons: ReasonCode[];
  route: 'reply.simple' | 'reply.complex' | null;
  visitorsWouldGet: VisitorsWouldGet;
}

export interface CoachDeps {
  /** The dashboard trust zone. */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** Wall time, for opening hours. */
  clock?: () => Date;
  /** Whether any channel is live (FEAT-034 adds the state); live until then. */
  channelLive?: () => Promise<boolean>;
}

export interface CoachTurnInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  text: string;
  includeUnreviewed: boolean;
}

export interface CoachTurnResult {
  question: CoachingMessageRow;
  answer: CoachingMessageRow;
  correction: CorrectionRecord | null;
}

/** The fixed replies of the propose path (no reply-model call). */
export const COACH_TEXTS = {
  proposal: "Here's the change I'd make. Confirm it and customers get it straight away.",
  unclear:
    "I couldn't tell which item to change. Tell me the product, question or day, and the new value.",
} as const;

const toHistory = (rows: CoachingMessageRow[]): HistoryMessage[] =>
  rows.map((m) => ({
    role: m.author === 'owner' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));

const asVisitorFact = (f: FactRecord): VisitorFact =>
  ({
    id: f.id,
    type: f.type,
    version: f.version,
    value: f.value,
    gstTreatment: f.gstTreatment,
    ...(f.type === 'promotion' ? { validUntil: f.validity.validUntil } : {}),
  }) as VisitorFact;

const REPLY_REASONS: Record<ReplyKey, ReasonCode> = {
  out_of_scope: 'out_of_scope',
  advice: 'advice',
  illegal: 'illegal',
  injection: 'injection',
  impersonation: 'impersonation',
};

/** D3: why the answer is what it is, from what the pipeline actually did. */
export function explain(input: {
  plan: TurnPlan | null;
  facts: CoachingFact[];
  answer: AnswerResult | null;
  outcome: CoachOutcome;
  replies: ReplyKey[];
  route: LogicalModel | null;
  minConfidence: number;
  aiPaused: boolean;
  channelLive: boolean;
}): Explainer {
  const used = new Set(input.answer?.factIds ?? []);
  const facts: ExplainedFact[] = input.facts.map((f) => ({
    id: f.id,
    type: f.type,
    label: factLabel(f),
    status: f.status,
    used: used.has(f.id),
  }));
  const unreviewedUsed = facts.some((f) => f.used && f.status === 'needs_review');
  const reasons = new Set<ReasonCode>();
  const plan = input.plan;
  if (used.size) reasons.add('matched_facts');
  if (!input.facts.length) reasons.add('no_matching_fact');
  if (plan && (plan.fallback || plan.confidence < input.minConfidence))
    reasons.add('low_confidence');
  for (const k of input.replies) reasons.add(REPLY_REASONS[k]);
  if (plan?.flags.injection) reasons.add('injection');
  if (plan?.flags.impersonation) reasons.add('impersonation');
  if ((input.answer?.attempts ?? 0) > 1) reasons.add('regenerated');
  if (input.answer?.violations.length) reasons.add('segment_blocked');
  if (input.outcome === 'escalated') reasons.add('escalated');
  if (input.answer?.slots.some((s) => s.startsWith('hours') || s === 'next_open'))
    reasons.add('hours_slot');
  if (unreviewedUsed) reasons.add('unreviewed_used');
  const route =
    input.route === 'reply.simple' || input.route === 'reply.complex' ? input.route : null;
  return {
    outcome: input.outcome,
    facts,
    usedFactIds: [...used],
    reasons: [...reasons],
    route,
    visitorsWouldGet: input.aiPaused
      ? 'fallback_paused'
      : !input.channelLive
        ? 'not_live'
        : unreviewedUsed
          ? 'without_unreviewed'
          : 'same',
  };
}

interface Prep {
  tenant: VisitorTenantState;
  history: CoachingMessageRow[];
  hours: HoursContext | null;
  profileVersion: number;
}

async function prepare(deps: CoachDeps, input: { tenantId: string; sessionId: string }) {
  const wall = (deps.clock ?? (() => new Date()))();
  return withTenant(deps.zdb, input.tenantId, async (tx): Promise<Prep> => {
    if (!(await getSession(tx, input.tenantId, input.sessionId)))
      throw new CoachingSessionNotFoundError('session not found');
    const tenant = await visitorTenantState(tx);
    if (!tenant) throw new Error('coaching: tenant state missing');
    const history = await sessionMessages(tx, input.tenantId, input.sessionId, HISTORY_LIMIT);
    const profile = await getBusinessProfile(tx, input.tenantId, wall.toISOString().slice(0, 10));
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
    return { tenant, history, hours, profileVersion: profile.version };
  });
}

interface Answered {
  body: string;
  outcome: CoachOutcome;
  explainer: Explainer;
  factIds: string[];
  plan: TurnPlan | null;
}

/** Step 4 of the turn: dispatch, then the verified answer on the coaching facts. */
async function answerStep(
  deps: CoachDeps,
  input: CoachTurnInput,
  prep: Prep,
  text: string,
  history: HistoryMessage[],
  plan: TurnPlan | null,
  facts: CoachingFact[] | null,
  ctx: DispatchContext,
): Promise<Answered> {
  const { tenant } = prep;
  const persona = tenant.persona;
  const channelLive = deps.channelLive ? await deps.channelLive() : true;
  const base = {
    minConfidence: tenant.routePolicy.minConfidence,
    aiPaused: tenant.aiPaused,
    channelLive,
  };
  if (!plan || !facts) {
    const t = textsFor(replyLanguage(null, text), persona);
    return {
      body: t.fallback,
      outcome: 'unavailable',
      factIds: [],
      plan,
      explainer: explain({
        ...base,
        plan,
        facts: [],
        answer: null,
        outcome: 'unavailable',
        replies: [],
        route: null,
      }),
    };
  }
  const language = replyLanguage(plan, text);
  const dispatch = await dispatchPlan(coachingRegistry, plan, ctx);
  let route: LogicalModel | null = routeReply(routeSignals(plan, false), tenant.routePolicy);
  const answer = await answerTurn(
    {
      facts,
      history,
      businessName: tenant.businessName,
      gstRegistered: tenant.gstRegistered,
      meta: { tenantId: input.tenantId, coachingSessionId: input.sessionId },
      model: route,
      now: prep.hours?.now ?? (deps.clock ?? (() => new Date()))(),
      language,
      register: plan.register,
      hours: prep.hours,
      systemSlots: systemSlots(prep.hours, language),
      plan,
      replies: dispatch.replies,
      minConfidence: tenant.routePolicy.minConfidence,
      persona,
    },
    // D5: the send gate doesn't apply; nothing is published anywhere.
    { llm: deps.llm, gateOpen: async () => true, publish: async () => {} },
  );
  if (!answer.composed) route = null;
  const t = textsFor(language, persona);
  const outcome: CoachOutcome =
    answer.outcome === 'gate_closed' ? 'unavailable' : (answer.outcome as CoachOutcome);
  const body =
    outcome === 'unavailable' ? [answer.text, t.fallback].filter(Boolean).join(' ') : answer.text;
  return {
    body,
    outcome,
    factIds: answer.factIds,
    plan,
    explainer: explain({
      ...base,
      plan,
      facts,
      answer,
      outcome,
      replies: dispatch.replies,
      route,
    }),
  };
}

function dispatchContext(
  deps: CoachDeps,
  input: CoachTurnInput,
  prep: Prep,
  turnId: string,
): DispatchContext {
  const { tenantId, sessionId, userId } = input;
  return {
    scope: 'coaching',
    tenantId,
    conversationId: sessionId,
    turnId,
    gateOpen: async () => true,
    consentGiven: async () => false,
    boundaryRules: async () => null,
    audit: async (e) => {
      await withTenant(deps.zdb, tenantId, (tx) =>
        audit.append(tx, tenantId, {
          action: 'agent.dispatch',
          actorType: 'agent',
          subjectType: 'coaching_session',
          subjectId: sessionId,
          payload: {
            task: auditCode(e.task),
            outcome: auditCode(e.outcome),
            ...(e.reason ? { reason: auditCode(e.reason) } : {}),
            ...(e.tool ? { tool: auditCode(e.tool) } : {}),
          },
        }),
      );
    },
    // Coaching has no conversation: the visitor-only handlers that use it never run here.
    conversation: {
      flag: async () => {
        throw new Error('coaching has no conversation');
      },
      recordAbuse: async () => {
        throw new Error('coaching has no conversation');
      },
      endAi: async () => {
        throw new Error('coaching has no conversation');
      },
    },
    coaching: {
      propose: (proposal) =>
        withTenant(deps.zdb, tenantId, async (tx) => {
          const p = proposal as ProposalInput;
          // D10: the merged hours must pass tenancy's rules.
          if (p.kind === 'edit_hours') {
            const merged = { ...(prep.tenant.hours ?? emptyHours()), ...p.after };
            if (!WeeklyHours.safeParse(merged).success)
              throw new InvalidCorrectionError('invalid hours');
          }
          const c = await proposeCorrection(coachingKb(tx, tenantId, userId, sessionId), {
            proposal: p,
          });
          return { correctionId: c.id };
        }),
    },
  };
}

const emptyHours = () => ({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });

async function search(
  deps: CoachDeps,
  input: CoachTurnInput,
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

/** Triage alongside retrieval, as in the visitor turn; a failed search is null. */
async function plan(
  deps: CoachDeps,
  input: CoachTurnInput,
  history: HistoryMessage[],
  text: string,
) {
  const meta = { tenantId: input.tenantId, coachingSessionId: input.sessionId };
  const [p, f] = await Promise.allSettled([
    triage(deps.llm, { history, meta, system: COACH_TRIAGE_SYSTEM }),
    search(deps, input, text),
  ]);
  return {
    plan: p.status === 'fulfilled' ? p.value : null,
    facts: f.status === 'fulfilled' ? f.value : null,
  };
}

/** The facts the last agent answer in the session used: candidates for a correction. */
async function previousFacts(
  deps: CoachDeps,
  input: CoachTurnInput,
  history: CoachingMessageRow[],
): Promise<{ answer: string | null; facts: VisitorFact[] }> {
  const last = [...history].reverse().find((m) => m.author === 'agent');
  if (!last) return { answer: null, facts: [] };
  const facts = await withTenant(deps.zdb, input.tenantId, async (tx) => {
    const out: VisitorFact[] = [];
    for (const id of last.factIds) {
      const f = await getFact(dashboardKb(tx, input.tenantId, input.userId), id).catch(() => null);
      if (f && (f.status === 'approved' || f.status === 'needs_review')) out.push(asVisitorFact(f));
    }
    return out;
  });
  return { answer: last.body, facts };
}

/**
 * One coaching turn (AGT-17, ONB-05; UC-04 1–5): triage ∥ coaching search; a `correct`
 * task goes through the propose step and `propose_correction`, anything else gets the
 * verified answer with its explainer. Both messages and the audit entry are stored in
 * one transaction at the end; no model runs inside a transaction.
 */
export async function runCoachingTurn(
  deps: CoachDeps,
  input: CoachTurnInput,
): Promise<CoachTurnResult> {
  const text = piiMask(input.text.trim());
  const prep = await prepare(deps, input);
  const history = [...toHistory(prep.history), { role: 'user' as const, content: text }];
  const turnId = crypto.randomUUID();
  const ctx = dispatchContext(deps, input, prep, turnId);
  const { plan: p, facts } = await plan(deps, input, history, text);

  let answer: Answered;
  let correctionId: string | null = null;
  if (p && p.tasks.some((t) => t.kind === 'correct')) {
    const prev = await previousFacts(deps, input, prep.history);
    const proposal = await proposeChange(deps.llm, {
      ownerText: text,
      previousAnswer: prev.answer,
      ctx: {
        candidates: candidatesOf([...(facts ?? []), ...prev.facts]),
        hours: prep.tenant.hours,
        profileVersion: prep.profileVersion,
      },
      meta: { tenantId: input.tenantId, coachingSessionId: input.sessionId },
    });
    const report = proposal
      ? await dispatchToolCall(
          coachingRegistry,
          { id: turnId, name: 'propose_correction', input: proposal },
          p,
          ctx,
        )
      : null;
    correctionId = report?.result?.proposal?.correctionId ?? null;
    answer = {
      body: correctionId ? COACH_TEXTS.proposal : COACH_TEXTS.unclear,
      outcome: 'answered',
      factIds: [],
      plan: p,
      explainer: explain({
        plan: p,
        facts: facts ?? [],
        answer: null,
        outcome: 'answered',
        replies: [],
        route: null,
        minConfidence: prep.tenant.routePolicy.minConfidence,
        aiPaused: prep.tenant.aiPaused,
        channelLive: deps.channelLive ? await deps.channelLive() : true,
      }),
    };
  } else answer = await answerStep(deps, input, prep, text, history, p, facts, ctx);

  const unreviewedUsed = answer.explainer.reasons.includes('unreviewed_used');
  return withTenant(deps.zdb, input.tenantId, async (tx) => {
    const [question, reply] = await appendMessages(tx, {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      messages: [
        {
          author: 'owner',
          kind: 'question',
          body: text,
          includeUnreviewed: input.includeUnreviewed,
        },
        {
          author: 'agent',
          kind: correctionId ? 'proposal' : 'answer',
          body: answer.body,
          includeUnreviewed: input.includeUnreviewed,
          outcome: answer.outcome,
          factIds: answer.factIds,
          explainer: correctionId ? null : answer.explainer,
          correctionId,
        },
      ],
    });
    let correction: CorrectionRecord | null = null;
    if (correctionId) {
      await attachCorrectionMessage(
        coachingKb(tx, input.tenantId, input.userId, input.sessionId),
        correctionId,
        reply!.id,
      );
      correction = await getCorrection({ tx, tenantId: input.tenantId }, correctionId);
    }
    await audit.append(tx, input.tenantId, {
      action: 'coach.turn',
      actorType: 'user',
      actorId: input.userId,
      subjectType: 'coaching_session',
      subjectId: input.sessionId,
      related: [{ type: 'coaching_message', id: reply!.id }],
      payload: {
        outcome: auditCode(answer.outcome),
        tasks: (answer.plan?.tasks ?? []).map((t) => auditCode(t.kind)),
        factIds: answer.factIds.map(auditId),
        includeUnreviewed: input.includeUnreviewed,
        unreviewedUsed,
        route: answer.explainer.route ? auditCode(answer.explainer.route) : null,
        proposal: correctionId !== null,
      },
    });
    return { question: question!, answer: reply!, correction };
  });
}

/**
 * UC-04 step 7 for the coached question (D7): after a confirm, the question answered
 * just before the correction is asked again, stored as kind `after`; the earlier answer
 * is `before`. Null both when the correction didn't follow an answer.
 */
export async function reanswer(
  deps: CoachDeps,
  input: { tenantId: string; userId: string; correction: CorrectionRecord },
): Promise<{ before: CoachingMessageRow | null; after: CoachingMessageRow | null }> {
  const { tenantId, userId, correction } = input;
  const sessionId = correction.coachingSessionId;
  if (!sessionId || !correction.coachingMessageId) return { before: null, after: null };
  const found = await withTenant(deps.zdb, tenantId, async (tx) => {
    const proposal = await getMessage(tx, tenantId, correction.coachingMessageId!);
    if (!proposal) return null;
    const all = await sessionMessages(tx, tenantId, sessionId);
    const before = [...all]
      .reverse()
      .find(
        (m) =>
          m.seq < proposal.seq &&
          m.author === 'agent' &&
          (m.kind === 'answer' || m.kind === 'after'),
      );
    if (!before) return null;
    const question = [...all]
      .reverse()
      .find((m) => m.seq < before.seq && m.author === 'owner' && m.kind === 'question');
    return question ? { before, question, history: all.filter((m) => m.seq < question.seq) } : null;
  });
  if (!found) return { before: null, after: null };
  const turn: CoachTurnInput = {
    tenantId,
    userId,
    sessionId,
    text: found.question.body,
    includeUnreviewed: found.question.includeUnreviewed,
  };
  const prep = await prepare(deps, turn);
  const history = [
    ...toHistory(found.history.slice(-HISTORY_LIMIT)),
    { role: 'user' as const, content: turn.text },
  ];
  const ctx = dispatchContext(deps, turn, prep, crypto.randomUUID());
  const { plan: p, facts } = await plan(deps, turn, history, turn.text);
  // A re-asked question is answered, never treated as a correction.
  const answerPlan = p ? { ...p, tasks: p.tasks.filter((t) => t.kind !== 'correct') } : null;
  if (answerPlan && !answerPlan.tasks.length) answerPlan.tasks = [{ kind: 'answer', args: {} }];
  const answer = await answerStep(deps, turn, prep, turn.text, history, answerPlan, facts, ctx);
  const after = await withTenant(deps.zdb, tenantId, async (tx) => {
    const [row] = await appendMessages(tx, {
      tenantId,
      sessionId,
      messages: [
        {
          author: 'agent',
          kind: 'after',
          body: answer.body,
          includeUnreviewed: turn.includeUnreviewed,
          outcome: answer.outcome,
          factIds: answer.factIds,
          explainer: answer.explainer,
          correctionId: correction.id,
        },
      ],
    });
    await audit.append(tx, tenantId, {
      action: 'coach.reanswer',
      actorType: 'user',
      actorId: userId,
      subjectType: 'coaching_session',
      subjectId: sessionId,
      related: [{ type: 'correction', id: correction.id }],
      payload: {
        outcome: auditCode(answer.outcome),
        factIds: answer.factIds.map(auditId),
      },
    });
    return row!;
  });
  return { before: found.before, after };
}
