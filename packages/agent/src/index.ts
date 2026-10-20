/**
 * Public interface of the `agent` module (architecture §5.2): the visitor turn, its
 * turn plan and dispatcher (ADR-025), and the verified-segment pipeline (ADR-008,
 * ADR-009). Calls models only through llm-gateway.
 */
export { runVisitorTurn, type TurnDeps, type TurnOutcome, type TurnResult } from './turn.js';
export {
  composeReply,
  MAX_REGENERATIONS,
  type ComposeOutcome,
  type ComposeResult,
} from './compose.js';
export {
  FALLBACK_PLAN,
  parsePlan,
  routeSignals,
  Task,
  TaskKind,
  triage,
  TRIAGE_OUTPUT_SCHEMA,
  TurnPlanSchema,
  type TurnPlan,
} from './plan.js';
export {
  createRegistry,
  dispatchPlan,
  dispatchToolCall,
  PHASE,
  visitorRegistry,
  type BoundaryRules,
  type DispatchAuditEntry,
  type DispatchContext,
  type DispatchReport,
  type Outcome,
  type RefusalReason,
  type Registry,
  type Scope,
  type TaskHandler,
  type TaskResult,
} from './dispatch.js';
export { fakeVisitorResponder } from './fake-responder.js';
export { fakeAgentScript, fakeTriage } from './fake-triage.js';
export { aiAllowed, type GateResult } from './gate.js';
export { formatSgd, renderPrice, renderSegment, SG_GST_PERCENT, withGst } from './render.js';
export { verifySegment, type Violation, type ViolationKind } from './verify.js';
export { assignRefs } from './slots.js';
export { texts } from './texts.js';
