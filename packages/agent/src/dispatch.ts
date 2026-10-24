import type { ToolCall } from '@kaki/llm-gateway';
import { z } from 'zod';
import type { TaskKind, TurnPlan } from './plan.js';
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

/** Boundary rules (APR-01); their shape arrives with FEAT-054. */
export type BoundaryRules = Record<string, unknown>;

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
  /** LED-02. False until consent is recorded (FEAT-049, FEAT-058): fail closed. */
  consentGiven(): Promise<boolean>;
  /** APR-01. Null until FEAT-054 adds the rules. */
  boundaryRules(): Promise<BoundaryRules | null>;
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
export type ReplyKey = 'out_of_scope' | 'advice' | 'illegal' | 'injection' | 'impersonation';

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
}

export interface TaskHandler<A = unknown> {
  kind: DispatchedKind;
  scopes: Scope[];
  args: z.ZodType<A>;
  needsConsent?: boolean;
  /** False refuses. With no rules (null) the handler decides; fail closed is expected. */
  checkBoundary?(rules: BoundaryRules | null, args: A): boolean;
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
    topic: z.enum(['medical', 'legal', 'financial', 'illegal', 'other']).catch('other'),
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

/** The visitor scope's handlers (ADR-025). Kinds without one are reported `unhandled`. */
export const visitorRegistry: Registry = createRegistry([
  crisisHandler,
  abuseHandler,
  outOfScopeHandler,
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
): Promise<{ reports: DispatchReport[]; replies: ReplyKey[]; endTurn?: { key: SafetyKey } }> {
  const queue = plan.tasks
    .flatMap((task, index) =>
      task.kind === 'answer' ? [] : [{ kind: task.kind, args: task.args as unknown, index }],
    )
    .sort((a, b) =>
      PHASE[a.kind] === PHASE[b.kind] ? a.index - b.index : PHASE[a.kind] === 'safety' ? -1 : 1,
    );
  const reports: DispatchReport[] = [];
  const replies: ReplyKey[] = [];
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
      outcome: report.outcome,
      ...(report.reason ? { reason: report.reason } : {}),
    });
    const result = 'result' in r ? r.result : undefined;
    if (result?.endTurn && PHASE[kind] === 'safety')
      return { reports, replies, endTurn: result.endTurn };
    if (result?.reply && PHASE[kind] === 'state' && !replies.includes(result.reply.key))
      replies.push(result.reply.key);
  }
  return { reports, replies };
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
