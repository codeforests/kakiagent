import { commitmentDecision, parseDiscount, type BoundaryRules } from '@kaki/approvals';
import type { MessageCard } from '@kaki/contracts';
import type { ToolCall } from '@kaki/llm-gateway';
import { z } from 'zod';
import type { TaskKind, TurnPlan } from './plan.js';
import { CaptureLeadArgs, prefillOf } from './lead.js';
import { RequestCommitmentArgs, type ApprovalPortResult } from './approval.js';
import type { SafetyKey } from './texts.js';

/**
 * The dispatcher (ADR-025 decisions 2, 3 and 6): the only place a planned task or a
 * model tool call becomes a side effect. Each later feature registers a handler for
 * its task kind (FEAT-023, -025, -038, -044, -049, -051, -055, -061); FEAT-004 ships
 * the checks with an empty registry.
 */

export type Scope = 'visitor' | 'coaching';
export type DispatchedKind = Exclude<TaskKind, 'answer'>;
export type Phase = 'safety' | 'state';

/** Safety tasks run first and may end the turn; then state changes; the reply comes last. */
export const PHASE: Record<DispatchedKind, Phase> = {
  crisis: 'safety',
  abuse: 'safety',
  withdraw_consent: 'state',
  capture_lead: 'state',
  request_commitment: 'state',
  escalate: 'state',
  data_request: 'state',
  handoff_channel: 'state',
  out_of_scope: 'state',
  correct: 'state',
};

export type Outcome = 'done' | 'refused' | 'failed' | 'unhandled';
export type RefusalReason =
  'scope' | 'gate_closed' | 'consent' | 'boundary' | 'invalid_args' | 'not_in_plan';

/** Boundary rules (APR-01; FEAT-054), owned by `@kaki/approvals`. */
export type { BoundaryRules };

export interface DispatchAuditEntry {
  task: TaskKind;
  tool?: string;
  outcome: Outcome;
  reason?: RefusalReason;
}

/**
 * What a handler may do to its own conversation (ADR-025 d2: writes go through the
 * owning module). The worker implements it with `@kaki/inbox` on the visitor zone, one
 * transaction per call; the eval runner and tests keep it in memory (FEAT-025 §5.2).
 */
export interface ConversationPort {
  /** Flags the conversation for staff; idempotent per reason (AGT-13). */
  flag(reason: 'abuse' | 'crisis'): Promise<void>;
  /** Records this turn as abuse; returns how many distinct abuse turns there are. */
  recordAbuse(turnId: string): Promise<number>;
  /** Ends the AI's part in the conversation: the send gate keeps it silent after. */
  endAi(reason: 'abuse'): Promise<void>;
  /**
   * Asks for a person (INB-05, AGT-06 `escalate_to_human`; FEAT-044 §5.4): inbox
   * `requestEscalation` routes, alerts and stores the visitor's notice.
   */
  escalate(
    source: 'visitor_asked' | 'unverified' | 'data_request',
  ): Promise<{ status: 'escalated' | 'already_escalated' | 'with_person' }>;
  /**
   * What a withdrawal would apply to (LED-07; FEAT-051 §5.3, D2): leads `withdrawalTarget`, the
   * conversation's contact or the same visitor's earlier one. Reads only.
   */
  withdrawalOffer(): Promise<WithdrawalOffer>;
  /**
   * The channels this visitor can continue on (CHN-07; FEAT-038 §5.7): channels
   * `handoffOptions`, live and (Telegram) with a bot username. Reads only.
   */
  handoffOptions(): Promise<HandoffChannels>;
  /**
   * Drafts an approval from the visitor's request (APR-02, AGT-06 `draft_approval`; FEAT-055
   * §5.2): approvals `draftApproval` with this turn's retrieved facts and the rules in force.
   * Nothing reaches the visitor but the waiting notice, or (D3) a plain quote sent at once.
   */
  draftApproval(request: RequestCommitmentArgs): Promise<ApprovalPortResult>;
}

/** Which channels a visitor can continue the chat on (FEAT-038 §5.2 step 2). */
export interface HandoffChannels {
  telegram: boolean;
  email: boolean;
}

/** Whether contact details are held from this visitor, and what the confirm card offers. */
export interface WithdrawalOffer {
  held: boolean;
  /** The contact agreed to offers: the card also offers "Just stop offers" (D1). */
  offers: boolean;
  /** The contact already withdrew consent. */
  withdrawn: boolean;
}

/**
 * Coaching's write port (FEAT-027 §5.2): the api implements it with `@kaki/kb`'s
 * `proposeCorrection` on the dashboard zone, in the turn's transaction.
 */
export interface CoachingPort {
  /** Stores an open correction; returns its ID. Throws when the proposal is invalid. */
  propose(proposal: unknown): Promise<{ correctionId: string }>;
}

export interface DispatchContext {
  scope: Scope;
  tenantId: string;
  conversationId: string;
  turnId: string;
  /** The AI send gate (ADR-013). */
  gateOpen(): Promise<boolean>;
  /** LED-02. The conversation's latest enquiry consent is granted (FEAT-049 D2); fail closed. */
  consentGiven(): Promise<boolean>;
  /** The granted enquiry consent's ID, for the lead form card (FEAT-049); absent: none. */
  leadConsentId?(): Promise<string | null>;
  /** APR-01: the rules in force for this turn (the safe defaults when none are saved). */
  boundaryRules(): Promise<BoundaryRules>;
  /** One entry per dispatched task: kinds and codes, never arguments or text (ADR-014). */
  audit(entry: DispatchAuditEntry): Promise<void>;
  /** The conversation's own flags and AI state (FEAT-025). */
  conversation: ConversationPort;
  /** Coaching scope only (FEAT-027). */
  coaching?: CoachingPort;
}

/**
 * System texts that replace or close the reply, rendered in the reply language
 * (FEAT-023): AGT-04's out-of-scope refusal and (FEAT-025) the advice and illegal
 * declines from `out_of_scope`'s topic, and the triage flags' refusals.
 */
export type ReplyKey =
  | 'out_of_scope'
  | 'advice'
  | 'illegal'
  | 'injection'
  | 'impersonation'
  | 'blocked_topic'
  | 'lead_consent'
  | 'lead_form'
  | 'withdraw_confirm'
  | 'withdraw_already'
  | 'withdraw_none'
  | 'data_request'
  | 'handoff_offer'
  | 'handoff_none';

export type { SafetyKey };

export interface TaskResult {
  /** A safety handler may end the turn with a fixed text, rendered by the turn (FEAT-025 D7). */
  endTurn?: { key: SafetyKey };
  /**
   * The handler did its visitor-facing part but a write failed (a crisis reply whose
   * flag couldn't be stored): reported `failed`, and `endTurn` still applies.
   */
  partial?: boolean;
  /**
   * A state task's visitor-facing system text (FEAT-023 §5.3). Handlers never see the
   * visitor's text or language; the turn renders the key.
   */
  reply?: { key: ReplyKey };
  /** A coaching proposal stored as an open correction (FEAT-027). */
  proposal?: { correctionId: string };
  /** What an escalation request did (FEAT-044). */
  escalation?: { status: 'escalated' | 'already_escalated' | 'with_person' };
  /** A widget card under the reply (FEAT-049 §5.3): data, never a side effect. */
  card?: MessageCard;
  /** What a commitment request did (FEAT-055). */
  approval?: ApprovalPortResult;
}

export interface TaskHandler<A = unknown> {
  kind: DispatchedKind;
  scopes: Scope[];
  args: z.ZodType<A>;
  needsConsent?: boolean;
  /** False refuses. With no rules (null) the handler decides; fail closed is expected. */
  checkBoundary?(rules: BoundaryRules, args: A): boolean;
  /** The model-assisted tool for this kind, if any (ADR-025 decision 3). */
  tool?: string;
  run(ctx: DispatchContext, args: A, idempotencyKey: string): Promise<TaskResult>;
}

export interface Registry {
  byKind: ReadonlyMap<DispatchedKind, TaskHandler>;
  byTool: ReadonlyMap<string, TaskHandler>;
}

export interface DispatchReport {
  task: TaskKind;
  index: number;
  outcome: Outcome;
  reason?: RefusalReason;
}

/** Handlers are typed by their own args; methods keep them assignable here. */
export function createRegistry(handlers: TaskHandler[]): Registry {
  const byKind = new Map<DispatchedKind, TaskHandler>();
  const byTool = new Map<string, TaskHandler>();
  for (const h of handlers) {
    if (byKind.has(h.kind)) throw new Error(`dispatcher: two handlers for ${h.kind}`);
    byKind.set(h.kind, h);
    if (h.tool) {
      if (byTool.has(h.tool)) throw new Error(`dispatcher: two handlers for tool ${h.tool}`);
      byTool.set(h.tool, h);
    }
  }
  return { byKind, byTool };
}

/** What an off-topic request is about (FEAT-025 D3); anything unknown reads as `other`. */
export const OutOfScopeArgs = z
  .object({
    topic: z.enum(['medical', 'legal', 'financial', 'illegal', 'blocked', 'other']).catch('other'),
  })
  .catch({ topic: 'other' });

/**
 * AGT-04 (ADR-025 decision 1, FEAT-023 D1): a question unrelated to the business gets
 * the fixed refusal, in code, whatever the reply model would do. AGT-13 (FEAT-025 D3):
 * medical, legal and financial advice and illegal requests get their own decline.
 */
export const outOfScopeHandler: TaskHandler<z.infer<typeof OutOfScopeArgs>> = {
  kind: 'out_of_scope',
  // UC-04 2a: the owner sees the same refusal a visitor would get (FEAT-027).
  scopes: ['visitor', 'coaching'],
  args: OutOfScopeArgs,
  async run(_ctx, { topic }) {
    if (topic === 'illegal') return { reply: { key: 'illegal' } };
    // APR-01 (FEAT-054 §5.3): a topic the business doesn't discuss.
    if (topic === 'blocked') return { reply: { key: 'blocked_topic' } };
    if (topic === 'medical' || topic === 'legal' || topic === 'financial')
      return { reply: { key: 'advice' } };
    return { reply: { key: 'out_of_scope' } };
  },
};

/**
 * AGT-13 (FEAT-025 §5.2): self-harm or danger. The conversation is flagged for staff and
 * the turn ends with the crisis contacts; the AI stays on. The reply never depends on
 * the flag being stored: a failed write is reported, and the contacts still go out.
 */
export const crisisHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'crisis',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const flagged = await ctx.conversation.flag('crisis').then(
      () => true,
      () => false,
    );
    return { endTurn: { key: 'crisis' }, ...(flagged ? {} : { partial: true }) };
  },
};

/** "Repeated abuse" (AGT-13): the second abuse turn in a conversation ends it (FEAT-025 D2). */
export const ABUSE_LIMIT = 2;

/** AGT-13: warn once; on repeat, flag the conversation and end the AI's part in it. */
export const abuseHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'abuse',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const count = await ctx.conversation.recordAbuse(ctx.turnId);
    if (count < ABUSE_LIMIT) return { endTurn: { key: 'abuse_warning' } };
    await ctx.conversation.flag('abuse');
    await ctx.conversation.endAi('abuse');
    return { endTurn: { key: 'abuse_ended' } };
  },
};

/**
 * AGT-06 `escalate_to_human` (FEAT-044 §5.4, D8): a visitor asked for a person in words. The
 * escalation's notice is the reply, so the handler returns no `reply`; answer tasks in the same
 * message are still answered.
 */
export const escalateHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'escalate',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const { status } = await ctx.conversation.escalate('visitor_asked');
    return { escalation: { status } };
  },
};

/**
 * `capture_lead` (FEAT-049 §5.3): needs the conversation's consent, so before it the
 * dispatcher refuses `consent` and the turn shows the consent card. After consent: the lead
 * form card, prefilled with the valid args only. Writes nothing; the widget's submit does.
 */
export const captureLeadHandler: TaskHandler<z.infer<typeof CaptureLeadArgs>> = {
  kind: 'capture_lead',
  scopes: ['visitor'],
  args: CaptureLeadArgs,
  needsConsent: true,
  async run(ctx, args) {
    const consentId = (await ctx.leadConsentId?.()) ?? null;
    if (!consentId) throw new Error('capture_lead: no granted consent');
    return {
      card: { kind: 'lead_form', consentId, prefill: prefillOf(args) },
      reply: { key: 'lead_form' },
    };
  },
};

/**
 * AGT-06 `draft_approval` (FEAT-055 §5.2, D1–D3): a quote, discount or commitment request is
 * drafted for approval in code; the model never answers it. The boundary check stays as the
 * ADR-025 hook (D1 sends above-maximum discounts to approval, so it passes today).
 */
export const requestCommitmentHandler: TaskHandler<RequestCommitmentArgs> = {
  kind: 'request_commitment',
  scopes: ['visitor'],
  tool: 'draft_approval',
  args: RequestCommitmentArgs,
  checkBoundary: (rules, args) =>
    commitmentDecision(rules, { discountPct: parseDiscount(args.discount) ?? 0 }) !== 'refuse',
  async run(ctx, args) {
    return { approval: await ctx.conversation.draftApproval(args) };
  },
};

/**
 * LED-07 (FEAT-051 §5.3; AC-2): "stop using my details" gets the confirm card, never a write.
 * The visitor's button records it (`/widget/v1/conversations/:id/withdraw`); who it applies
 * to comes from the conversation, never the message (D2).
 */
export const withdrawConsentHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'withdraw_consent',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const o = await ctx.conversation.withdrawalOffer();
    if (!o.held) return { reply: { key: 'withdraw_none' } };
    if (o.withdrawn) return { reply: { key: 'withdraw_already' } };
    return { card: { kind: 'withdraw', offers: o.offers }, reply: { key: 'withdraw_confirm' } };
  },
};

/**
 * GOV-05 routing (FEAT-051 §5.3, D5; AC-9): a request to delete their data goes to the team as
 * an escalation until FEAT-061 replaces this `run` with a data-subject request.
 */
export const dataRequestHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'data_request',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const { status } = await ctx.conversation.escalate('data_request');
    return { escalation: { status }, reply: { key: 'data_request' } };
  },
};

/**
 * CHN-07 (FEAT-038 §5.7; AC-9): "continue on Telegram" gets the handoff card listing only the
 * live channels, never a write; the widget's `/handoff` route makes the link. No consent (D1).
 */
export const handoffChannelHandler: TaskHandler<Record<string, unknown>> = {
  kind: 'handoff_channel',
  scopes: ['visitor'],
  args: z.record(z.string(), z.unknown()).catch({}),
  async run(ctx) {
    const o = await ctx.conversation.handoffOptions();
    if (!o.telegram && !o.email) return { reply: { key: 'handoff_none' } };
    return {
      card: { kind: 'handoff', telegram: o.telegram, email: o.email },
      reply: { key: 'handoff_offer' },
    };
  },
};

/** The visitor scope's handlers (ADR-025). Kinds without one are reported `unhandled`. */
export const visitorRegistry: Registry = createRegistry([
  crisisHandler,
  abuseHandler,
  outOfScopeHandler,
  escalateHandler,
  captureLeadHandler,
  requestCommitmentHandler,
  withdrawConsentHandler,
  dataRequestHandler,
  handoffChannelHandler,
]);

type Checked = { ok: true; args: unknown } | { ok: false; reason: RefusalReason };

/** ADR-025 decision 2's checks, in code, before any handler runs. */
async function check(h: TaskHandler, rawArgs: unknown, ctx: DispatchContext): Promise<Checked> {
  if (!h.scopes.includes(ctx.scope)) return { ok: false, reason: 'scope' };
  if (!(await ctx.gateOpen())) return { ok: false, reason: 'gate_closed' };
  const parsed = h.args.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, reason: 'invalid_args' };
  if (h.needsConsent && !(await ctx.consentGiven())) return { ok: false, reason: 'consent' };
  if (h.checkBoundary && !h.checkBoundary(await ctx.boundaryRules(), parsed.data))
    return { ok: false, reason: 'boundary' };
  return { ok: true, args: parsed.data };
}

async function runOne(
  h: TaskHandler,
  rawArgs: unknown,
  index: number,
  ctx: DispatchContext,
): Promise<{ outcome: Outcome; reason?: RefusalReason; result?: TaskResult }> {
  const checked = await check(h, rawArgs, ctx);
  if (!checked.ok) return { outcome: 'refused', reason: checked.reason };
  try {
    const result = await h.run(ctx, checked.args, `${ctx.turnId}:${index}`);
    return { outcome: result.partial ? 'failed' : 'done', result };
  } catch {
    // One task failing does not drop the others (ADR-025 decision 6).
    return { outcome: 'failed' };
  }
}

/**
 * Runs a plan's non-answer tasks: safety first, then state changes, each in plan
 * order. Every task is audited. A safety `endTurn` stops the dispatch.
 */
export async function dispatchPlan(
  reg: Registry,
  plan: TurnPlan,
  ctx: DispatchContext,
): Promise<{
  reports: DispatchReport[];
  replies: ReplyKey[];
  endTurn?: { key: SafetyKey };
  /** The first card a handler returned (FEAT-049). */
  card?: MessageCard;
}> {
  const queue = plan.tasks
    .flatMap((task, index) =>
      task.kind === 'answer' ? [] : [{ kind: task.kind, args: task.args as unknown, index }],
    )
    .sort((a, b) =>
      PHASE[a.kind] === PHASE[b.kind] ? a.index - b.index : PHASE[a.kind] === 'safety' ? -1 : 1,
    );
  const reports: DispatchReport[] = [];
  const replies: ReplyKey[] = [];
  let card: MessageCard | undefined;
  for (const { kind, args, index } of queue) {
    const h = reg.byKind.get(kind);
    const r = h ? await runOne(h, args, index, ctx) : { outcome: 'unhandled' as const };
    const report: DispatchReport = {
      task: kind,
      index,
      outcome: r.outcome,
      ...('reason' in r && r.reason ? { reason: r.reason } : {}),
    };
    reports.push(report);
    await ctx.audit({
      task: report.task,
      // The tool the task stands for (FEAT-055 AC-1: `draft_approval`), as a code.
      ...(h?.tool ? { tool: h.tool } : {}),
      outcome: report.outcome,
      ...(report.reason ? { reason: report.reason } : {}),
    });
    const result = 'result' in r ? r.result : undefined;
    if (result?.endTurn && PHASE[kind] === 'safety')
      return { reports, replies, endTurn: result.endTurn };
    if (result?.reply && PHASE[kind] === 'state' && !replies.includes(result.reply.key))
      replies.push(result.reply.key);
    if (result?.card && !card) card = result.card;
  }
  return { reports, replies, ...(card ? { card } : {}) };
}

/**
 * A model tool call is a proposal (ADR-025 decision 3): refused when the scope has no
 * such tool or the plan did not enable its task this turn, then checked like a task.
 * No tool exists yet; the first model-assisted tool (FEAT-049) wires this into the reply.
 */
export async function dispatchToolCall(
  reg: Registry,
  call: ToolCall,
  plan: TurnPlan,
  ctx: DispatchContext,
): Promise<DispatchReport & { result?: TaskResult }> {
  const h = reg.byTool.get(call.name);
  const index = h ? plan.tasks.findIndex((t) => t.kind === h.kind) : -1;
  let out: DispatchReport & { result?: TaskResult };
  if (!h) out = { task: 'answer', index, outcome: 'refused', reason: 'scope' };
  else if (index < 0) out = { task: h.kind, index, outcome: 'refused', reason: 'not_in_plan' };
  else {
    const r = await runOne(h, call.input, index, ctx);
    out = { task: h.kind, index, outcome: r.outcome };
    if (r.reason) out.reason = r.reason;
    if (r.result) out.result = r.result;
  }
  await ctx.audit({
    task: out.task,
    tool: h ? call.name : 'unknown',
    outcome: out.outcome,
    ...(out.reason ? { reason: out.reason } : {}),
  });
  return out;
}
