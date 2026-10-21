import { withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId, type AuditPayload } from '@kaki/governance';
import {
  appendAgentReply,
  endAiConversation,
  flagConversation,
  getMessage,
  hasAssistantMessage,
  noticeSince,
  recentMessages,
  recordAbuse,
  replyExists,
} from '@kaki/inbox';
import { searchVisitorFacts, visitorKb, type VisitorFact } from '@kaki/kb';
import { routeReply, type LlmGateway, type LogicalModel } from '@kaki/llm-gateway';
import { openStatus } from '@kaki/tenancy';
import { answerTurn, type AnswerOutcome, type AnswerResult } from './answer.js';
import {
  dispatchPlan,
  visitorRegistry,
  type DispatchContext,
  type DispatchReport,
  type Registry,
} from './dispatch.js';
import { aiAllowed } from './gate.js';
import { systemSlots, type HoursContext } from './hours-text.js';
import { replyLanguage, type ReplyLanguage } from './language.js';
import { routeSignals, triage, type TurnPlan } from './plan.js';
import { HISTORY_LIMIT } from './prompt.js';
import { safetyText, textsFor } from './texts.js';

export interface TurnDeps {
  /** The visitor trust zone (ADR-009): it can read only what a visitor conversation may see. */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** Releases a verified segment to the conversation's realtime channel. */
  publishSegment?: (segment: { turnId: string; seq: number; text: string }) => Promise<void>;
  /** The visitor scope's task handlers (ADR-025); the production registry by default. */
  registry?: Registry;
  /** Latency timer (ms). */
  now?: () => number;
  /** Wall time, for opening hours and the prompt's SGT time (FEAT-023). */
  clock?: () => Date;
}

export interface TurnJobInput {
  tenantId: string;
  conversationId: string;
  messageId: string;
}

/** `ended`: a safety task ended the turn with its own text (ADR-025 decision 6). */
export type TurnOutcome = AnswerOutcome | 'paused' | 'ended';

type Stored = NonNullable<Awaited<ReturnType<typeof appendAgentReply>>>;

export type TurnResult = Stored & {
  outcome: TurnOutcome;
  timings: (AnswerResult['timings'] & { triageMs: number | null }) | null;
  /** The reply language (AGT-03) and whether the after-hours notice went with it (AGT-09). */
  language: ReplyLanguage;
  afterHours: boolean;
  /** The triaged plan and what the dispatcher did with it (FEAT-004). Null when the gate was closed. */
  plan: TurnPlan | null;
  dispatched: DispatchReport[];
  /** The model of the first reply attempt (ADR-007 routing). */
  route: LogicalModel | null;
};

/**
 * One visitor turn (UC-20; ADR-007, ADR-008, ADR-009, ADR-013, ADR-025): gate → triage
 * in parallel with `lookup_kb` → dispatch the plan's tasks → verified reply on the
 * routed model → store with fact IDs and disclosure. No transaction is held while a
 * model runs (FEAT-022 D8). Idempotent: a turn whose visitor message already has a
 * reply does nothing, and the unique `in_reply_to` index settles a race.
 */
export async function runVisitorTurn(
  deps: TurnDeps,
  job: TurnJobInput,
): Promise<TurnResult | null> {
  const { zdb, llm } = deps;
  const { tenantId, conversationId } = job;
  const now = deps.now ?? (() => performance.now());
  const wall = (deps.clock ?? (() => new Date()))();

  const prep = await withTenant(zdb, tenantId, async (tx) => {
    const message = await getMessage(tx, tenantId, job.messageId);
    if (!message || message.author !== 'visitor') return null;
    if (await replyExists(tx, tenantId, message.id)) return null;
    const gate = await aiAllowed(tx, tenantId, conversationId);
    const history = await recentMessages(tx, {
      tenantId,
      conversationId,
      upToSeq: message.seq,
      limit: HISTORY_LIMIT,
    });
    const disclosed = await hasAssistantMessage(tx, tenantId, conversationId);
    // AGT-09: the business is closed now, and nobody has been told so this closed period.
    const tenant = gate.tenant;
    const status = tenant?.hours
      ? openStatus(tenant.hours, tenant.openOnPublicHolidays, wall)
      : null;
    const hours: HoursContext | null =
      tenant?.hours && status
        ? {
            hours: tenant.hours,
            openOnPublicHolidays: tenant.openOnPublicHolidays,
            status,
            now: wall,
          }
        : null;
    const noticeDue =
      status !== null &&
      !status.open &&
      !(await noticeSince(tx, tenantId, conversationId, 'after_hours', status.since));
    return { message, gate, history, disclosed, hours, noticeDue };
  });
  if (!prep) return null;
  const { message, gate, hours } = prep;
  const businessName = gate.tenant?.businessName ?? '';
  // AGT-08, AGT-11 (FEAT-024): the tenant's persona and wording; defaults when unset.
  const persona = gate.tenant?.persona;
  const meta = { tenantId, conversationId, turnId: message.id };
  // Until triage answers, the visitor's script decides (FEAT-023 D4).
  let language: ReplyLanguage = replyLanguage(null, message.body);
  let slotValues = systemSlots(hours, language);
  let plan: TurnPlan | null = null;
  let dispatched: DispatchReport[] = [];
  let route: LogicalModel | null = null;
  let triageMs: number | null = null;

  async function store(
    outcome: TurnOutcome,
    author: 'agent' | 'system',
    text: string,
    composed: AnswerResult | null,
  ): Promise<TurnResult | null> {
    const t = textsFor(language, persona);
    const disclosure = prep!.disclosed ? null : t.disclosure(businessName);
    // FEAT-023 D6: the return time is rendered, never written by the model.
    const notice = prep!.noticeDue
      ? { kind: 'after_hours' as const, text: t.afterHours(slotValues.get('next_open') ?? null) }
      : null;
    const stored = await withTenant(zdb, tenantId, async (tx) => {
      const reply = await appendAgentReply(tx, {
        tenantId,
        conversationId,
        inReplyTo: message.id,
        text,
        author,
        factIds: composed?.factIds ?? [],
        disclosure,
        notice,
      });
      if (!reply) return null;
      const entry = (action: string, payload?: AuditPayload) =>
        audit.append(tx, tenantId, {
          action,
          actorType: 'agent',
          subjectType: 'message',
          subjectId: reply.message.id,
          related: [{ type: 'conversation', id: conversationId }],
          payload,
        });
      // Guardrail results (ADR-008 decision 5, GOV-01): the rule that fired, never the text.
      for (const v of composed?.violations ?? [])
        await entry('guardrail.segment_blocked', { kind: auditCode(v.kind) });
      if (outcome === 'escalated') await entry('guardrail.escalated');
      if (outcome === 'unavailable' || outcome === 'paused') await entry('agent.fallback_sent');
      // The decision's structured rationale (GOV-01, architecture OI-8): what happened and
      // which facts it rests on.
      await entry('agent.decision', {
        outcome: auditCode(outcome),
        factIds: (composed?.factIds ?? []).map(auditId),
        attempts: composed?.attempts ?? 0,
        violations: composed?.violations.length ?? 0,
        // ADR-007 routing and the ADR-025 plan: codes only.
        route: route ? auditCode(route) : null,
        models: (composed?.models ?? []).map(auditCode),
        tasks: (plan?.tasks ?? []).map((t) => auditCode(t.kind)),
        planFallback: plan?.fallback ?? null,
        // FEAT-023: language, register, the system slots rendered and the notice (codes only).
        language: auditCode(language),
        register: plan ? auditCode(plan.register) : null,
        slots: (composed?.slots ?? []).map(auditCode),
        afterHours: notice !== null,
        // FEAT-024: the tone and whether emoji were removed (codes only).
        tone: persona ? auditCode(persona.tone) : null,
        emojiRemoved: composed?.emojiRemoved ?? false,
      });
      return reply;
    });
    return stored
      ? {
          ...stored,
          outcome,
          timings: composed ? { ...composed.timings, triageMs } : null,
          plan,
          dispatched,
          route,
          language,
          afterHours: notice !== null,
        }
      : null;
  }

  if (!gate.open) {
    // UC-20 5e. Paused: the visitor gets the fallback (architecture §6.5). A human
    // owner or a closed conversation: the AI says nothing.
    return gate.reason === 'paused'
      ? store('paused', 'system', textsFor(language, persona).fallback, null)
      : null;
  }

  const history = prep.history.map((m) => ({
    role: m.author === 'visitor' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));

  // Triage runs alongside retrieval (ADR-007: no extra latency on the critical path, NFR-01).
  const triageStart = now();
  const planned = triage(llm, { history, meta }).then((p) => {
    triageMs = Math.round(now() - triageStart);
    return p;
  });
  const retrieved = retrieve();
  async function retrieve(): Promise<VisitorFact[]> {
    const { vectors } = await llm.embed({ texts: [message.body], purpose: 'query', meta });
    return withTenant(zdb, tenantId, async (tx) => {
      const found = await searchVisitorFacts(visitorKb(tx, tenantId, conversationId), vectors[0]!);
      await audit.append(tx, tenantId, {
        action: 'tool.lookup_kb',
        actorType: 'agent',
        subjectType: 'conversation',
        subjectId: conversationId,
        related: [{ type: 'message', id: message.id }],
        payload: { tool: auditCode('lookup_kb'), factIds: found.map((f) => auditId(f.id)) },
      });
      return found;
    });
  }
  const [planResult, factsResult] = await Promise.allSettled([planned, retrieved]);
  // `triage` never rejects; the fallback plan stands in for any failure.
  plan = planResult.status === 'fulfilled' ? planResult.value : null;
  if (factsResult.status === 'rejected' || !plan) {
    // NFR-04: no embedder, no grounded answer. The fallback closes the turn (FEAT-022 D6).
    return store('unavailable', 'system', textsFor(language, persona).fallback, null);
  }
  const facts = factsResult.value;
  language = replyLanguage(plan, message.body);
  slotValues = systemSlots(hours, language);
  const t = textsFor(language, persona);

  // ADR-025: the dispatcher turns the plan's tasks into side effects, or reports why not.
  const ctx: DispatchContext = {
    scope: 'visitor',
    tenantId,
    conversationId,
    turnId: message.id,
    gateOpen: async () =>
      (await withTenant(zdb, tenantId, (tx) => aiAllowed(tx, tenantId, conversationId))).open,
    // Consent (LED-02) arrives with FEAT-049/058 and boundary rules (APR-01) with FEAT-054.
    consentGiven: async () => false,
    boundaryRules: async () => null,
    audit: async (e) => {
      await withTenant(zdb, tenantId, (tx) =>
        audit.append(tx, tenantId, {
          action: 'agent.dispatch',
          actorType: 'agent',
          subjectType: 'message',
          subjectId: message.id,
          related: [{ type: 'conversation', id: conversationId }],
          payload: {
            task: auditCode(e.task),
            outcome: auditCode(e.outcome),
            ...(e.reason ? { reason: auditCode(e.reason) } : {}),
            ...(e.tool ? { tool: auditCode(e.tool) } : {}),
          },
        }),
      );
    },
    // AGT-13 (FEAT-025 §5.4): the conversation's own flags and AI state, one transaction each.
    conversation: {
      flag: async (reason) => {
        await withTenant(zdb, tenantId, (tx) =>
          flagConversation(tx, tenantId, conversationId, reason),
        );
      },
      recordAbuse: (turnId) =>
        withTenant(zdb, tenantId, (tx) => recordAbuse(tx, tenantId, conversationId, turnId)),
      endAi: async (reason) => {
        await withTenant(zdb, tenantId, (tx) =>
          endAiConversation(tx, tenantId, conversationId, reason),
        );
      },
    },
  };
  const dispatch = await dispatchPlan(deps.registry ?? visitorRegistry, plan, ctx);
  dispatched = dispatch.reports;
  if (dispatch.endTurn)
    return store('ended', 'agent', safetyText(t, dispatch.endTurn.key, businessName), null);

  route = routeReply(routeSignals(plan, false), gate.tenant.routePolicy);
  const composed = await answerTurn(
    {
      facts,
      history,
      businessName,
      gstRegistered: gate.tenant.gstRegistered,
      meta,
      model: route,
      now: wall,
      language,
      register: plan.register,
      hours,
      systemSlots: slotValues,
      plan,
      replies: dispatch.replies,
      minConfidence: gate.tenant.routePolicy.minConfidence,
      persona,
    },
    {
      llm,
      gateOpen: async () =>
        (await withTenant(zdb, tenantId, (tx) => aiAllowed(tx, tenantId, conversationId))).open,
      publish: async (s) => deps.publishSegment?.({ turnId: message.id, ...s }),
    },
  );

  // A fixed AGT-04 text used no reply model (FEAT-023 D1).
  if (!composed.composed) route = null;
  switch (composed.outcome) {
    case 'answered':
    case 'escalated':
    case 'out_of_scope':
    case 'unsure':
      return store(composed.outcome, 'agent', composed.text, composed);
    case 'unavailable':
      return composed.text
        ? store('unavailable', 'agent', `${composed.text} ${t.fallback}`, composed)
        : store('unavailable', 'system', t.fallback, composed);
    case 'gate_closed': {
      const now = await withTenant(zdb, tenantId, (tx) => aiAllowed(tx, tenantId, conversationId));
      const paused = !now.open && now.reason === 'paused';
      if (paused)
        return store(
          'paused',
          composed.text ? 'agent' : 'system',
          [composed.text, t.fallback].filter(Boolean).join(' '),
          composed,
        );
      return composed.text ? store('gate_closed', 'agent', composed.text, composed) : null;
    }
  }
}
