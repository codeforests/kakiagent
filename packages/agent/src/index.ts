/**
 * Public interface of the `agent` module (architecture §5.2): the visitor turn, its
 * turn plan and dispatcher (ADR-025), and the verified-segment pipeline (ADR-008,
 * ADR-009). Calls models only through llm-gateway.
 */
export { runVisitorTurn, type TurnDeps, type TurnOutcome, type TurnResult } from './turn.js';
export {
  answerTurn,
  replyPlan,
  type AnswerInput,
  type AnswerOutcome,
  type AnswerResult,
  type ReplyPlan,
} from './answer.js';
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
  ABUSE_LIMIT,
  abuseHandler,
  createRegistry,
  crisisHandler,
  dispatchPlan,
  dispatchToolCall,
  OutOfScopeArgs,
  outOfScopeHandler,
  PHASE,
  visitorRegistry,
  type BoundaryRules,
  type ConversationPort,
  type DispatchAuditEntry,
  type DispatchContext,
  type DispatchReport,
  type Outcome,
  type RefusalReason,
  type ReplyKey,
  type Registry,
  type SafetyKey,
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
export {
  assistantDefaults,
  CRISIS_CONTACTS,
  DEFAULT_BOT_NAME,
  DEFAULT_GREETING,
  safetyText,
  texts,
  textsFor,
  type AssistantDefaults,
  type Texts,
} from './texts.js';
export {
  hasHan,
  LANGUAGE_NAMES,
  replyLanguage,
  type Register,
  type ReplyLanguage,
} from './language.js';
export {
  formatDay,
  formatNextOpen,
  formatTime,
  hoursLines,
  systemSlots,
  type HoursContext,
} from './hours-text.js';
