import type { ToolCall } from '@kaki/llm-gateway';
import type { z } from 'zod';
import type { TaskKind, TurnPlan } from './plan.js';

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
}

export interface TaskResult {
  /** A safety handler may end the turn with a fixed text (crisis contacts, FEAT-025). */
  endTurn?: { text: string };
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

/** The visitor scope's handlers. Empty in FEAT-004: every non-answer task is `unhandled`. */
export const visitorRegistry: Registry = createRegistry([]);

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
    return { outcome: 'done', result: await h.run(ctx, checked.args, `${ctx.turnId}:${index}`) };
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
): Promise<{ reports: DispatchReport[]; endTurn?: { text: string } }> {
  const queue = plan.tasks
    .flatMap((task, index) =>
      task.kind === 'answer' ? [] : [{ kind: task.kind, args: task.args as unknown, index }],
    )
    .sort((a, b) =>
      PHASE[a.kind] === PHASE[b.kind] ? a.index - b.index : PHASE[a.kind] === 'safety' ? -1 : 1,
    );
  const reports: DispatchReport[] = [];
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
    const endTurn = 'result' in r ? r.result?.endTurn : undefined;
    if (endTurn && PHASE[kind] === 'safety') return { reports, endTurn };
  }
  return { reports };
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
