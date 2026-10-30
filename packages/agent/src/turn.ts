import { rulesInForce } from '@kaki/approvals';
import { withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId, type AuditPayload } from '@kaki/governance';
import {
  appendAgentReply,
  endAiConversation,
  flagConversation,
  getMessage,
  hasAssistantMessage,
  markQuestionGap,
  noticeSince,
  recentMessages,
  recordAbuse,
  replyExists,
  type GapReason,
} from '@kaki/inbox';
import { searchVisitorFacts, visitorKb, type VisitorFact } from '@kaki/kb';
import { routeReply, type LlmGateway, type LogicalModel } from '@kaki/llm-gateway';
import { openStatus } from '@kaki/tenancy';
import { answerTurn, type AnswerOutcome, type AnswerResult } from './answer.js';
import { applyBoundary, triageTail } from './boundary.js';
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
import type { Violation } from './verify.js';
import { safetyText, textsFor, type SafetyKey } from './texts.js';

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
export type TurnOutcome = AnswerOutcome | 'paused' | 'ended' | 'not_live';

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
/** Turn outcomes that mark the visitor's question as a coverage gap (FEAT-019 D2). */
/** FEAT-054: a boundary hit has its own guardrail action; other kinds are `segment_blocked`. */
const GUARDRAIL_ACTION: Partial<Record<Violation['kind'], string>> = {
  commitment: 'guardrail.boundary_commitment',
  discount_offer: 'guardrail.boundary_discount',
};

const GAP_OUTCOMES = new Map<TurnOutcome, GapReason>([
  ['unavailable', 'unavailable'],
  ['unsure', 'unsure'],
  ['escalated', 'escalated'],
]);

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
    // APR-01 (FEAT-054 §5.3): read every turn, no cache, so a save applies to the next reply.
    const rules = await rulesInForce(tx, tenantId);
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
      ? openStatus(tenant.hours, tenant.openOnPublicHolidays, wall, tenant.holidays)
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
    // FEAT-034: the offline notice is stored once, not once per visitor message.
    const lastReply = history.filter((m) => m.author !== 'visitor').at(-1)?.body ?? null;
    return { message, gate, rules, history, disclosed, hours, noticeDue, lastReply };
  });
  if (!prep) return null;
  const { message, gate, hours, rules } = prep;
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
  // A blocked topic was refused in code this turn (FEAT-054 §5.3).
  let blockedTopic = false;
  // The retrieval vector, kept to mark an unanswered question as a coverage gap (FEAT-019 D2).
  let queryVector: number[] | null = null;

  async function store(
    outcome: TurnOutcome,
    author: 'agent' | 'system',
    text: string,
    composed: AnswerResult | null,
    safety: SafetyKey | null = null,
  ): Promise<TurnResult | null> {
    const t = textsFor(language, persona);
    const disclosure = prep!.disclosed ? null : t.disclosure(businessName);
    // FEAT-025 §5.4: an abuse-ended chat says so; a crisis or warning reply carries no
    // notice, so the after-hours notice waits for the next reply of the closed period.
    // FEAT-023 D6: the return time is rendered, never written by the model.
    const notice =
      safety === 'abuse_ended'
        ? { kind: 'chat_ended' as const, text: t.chatEnded }
        : prep!.noticeDue && safety === null
          ? {
              kind: 'after_hours' as const,
              text: t.afterHours(slotValues.get('next_open') ?? null),
            }
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
        language,
      });
      if (!reply) return null;
      // KB-09 (FEAT-019 §5.2): a question the turn tried to answer and couldn't is a gap.
      const gapReason = GAP_OUTCOMES.get(outcome);
      if (gapReason && queryVector && plan?.tasks.some((task) => task.kind === 'answer'))
        await markQuestionGap(tx, {
          tenantId,
          messageId: message.id,
          reason: gapReason,
          embedding: queryVector,
        });
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
        await entry(GUARDRAIL_ACTION[v.kind] ?? 'guardrail.segment_blocked', {
          kind: auditCode(v.kind),
        });
      if (outcome === 'escalated') await entry('guardrail.escalated');
      if (outcome === 'unavailable' || outcome === 'paused') await entry('agent.fallback_sent');
      // UC-20 3a and 3d (ADR-009): the attempt is audit-logged, as codes only (FEAT-025).
      if (plan?.flags.injection) await entry('guardrail.injection_detected');
      if (plan?.flags.impersonation) await entry('guardrail.impersonation_detected');
      if (blockedTopic) await entry('guardrail.boundary_topic');
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
        afterHours: notice?.kind === 'after_hours',
        // FEAT-024: the tone and whether emoji were removed (codes only).
        tone: persona ? auditCode(persona.tone) : null,
        emojiRemoved: composed?.emojiRemoved ?? false,
        // FEAT-025: the safety text that ended the turn and triage's flags (codes only).
        safety: safety ? auditCode(safety) : null,
        injection: plan?.flags.injection ?? false,
        impersonation: plan?.flags.impersonation ?? false,
        // FEAT-054: which boundary rules applied (null: the safe defaults, never saved).
        rulesVersion: rules.version,
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
          afterHours: notice?.kind === 'after_hours',
        }
      : null;
  }

  /** The channel's offline message in the visitor's language (ONB-10, FEAT-034 §5.3). */
  const offlineText = (offline: { message: { en: string; zh: string } }) =>
    language === 'zh' ? offline.message.zh : offline.message.en;

  if (!gate.open) {
    // UC-20 5e. Paused: the visitor gets the fallback (architecture §6.5), once per run of
    // visitor messages while staff answer (FEAT-057 D2). Not live: the channel's offline
    // message, once, with no model call (ONB-10). A human owner or a closed conversation:
    // the AI says nothing.
    if (gate.reason === 'paused') {
      const text = textsFor(language, persona).fallback;
      return prep.lastReply === text ? null : store('paused', 'system', text, null);
    }
    if (gate.reason === 'not_live') {
      const text = offlineText(gate.offline);
      return prep.lastReply === text ? null : store('not_live', 'system', text, null);
    }
    return null;
  }

  const history = prep.history.map((m) => ({
    role: m.author === 'visitor' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));

  // Triage runs alongside retrieval (ADR-007: no extra latency on the critical path, NFR-01).
  const triageStart = now();
  const planned = triage(llm, { history, meta, tail: triageTail(rules.rules) }).then((p) => {
    triageMs = Math.round(now() - triageStart);
    return p;
  });
  const retrieved = retrieve();
  async function retrieve(): Promise<VisitorFact[]> {
    const { vectors } = await llm.embed({ texts: [message.body], purpose: 'query', meta });
    return withTenant(zdb, tenantId, async (tx) => {
      const found = await searchVisitorFacts(visitorKb(tx, tenantId, conversationId), vectors[0]!);
      queryVector = vectors[0]!;
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
  ({ plan, blocked: blockedTopic } = applyBoundary(plan, rules.rules, message.body));
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
    // Consent (LED-02) arrives with FEAT-049/058.
    consentGiven: async () => false,
    boundaryRules: async () => rules.rules,
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
  if (dispatch.endTurn) {
    const key = dispatch.endTurn.key;
    return store('ended', 'agent', safetyText(t, key, businessName), null, key);
  }

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
      rules: rules.rules,
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
    case 'refused':
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
      // The channel went offline mid-reply: keep the released prefix, close with the notice.
      if (!now.open && now.reason === 'not_live')
        return store(
          'not_live',
          composed.text ? 'agent' : 'system',
          [composed.text, offlineText(now.offline)].filter(Boolean).join(' '),
          composed,
        );
      return composed.text ? store('gate_closed', 'agent', composed.text, composed) : null;
    }
  }
}
