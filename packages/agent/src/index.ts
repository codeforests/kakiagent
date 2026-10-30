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
  TRIAGE_SYSTEM,
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
  type CoachingPort,
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
export { leakGuard, LEAK_MARKERS, ruleText, WINDOW, type LeakGuard } from './guard.js';
export { asData, buildVisitorPrompt } from './prompt.js';
export { fakeTriage } from './fake-triage.js';
export {
  applyBoundary,
  blockedTopicHit,
  boundaryGuard,
  triageTail,
  type BoundaryGuard,
} from './boundary.js';
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
export { COACH_TRIAGE_SYSTEM } from './coach-prompt.js';
export {
  candidatesOf,
  MAX_CANDIDATES,
  parseProposal,
  PROPOSE_OUTPUT_SCHEMA,
  PROPOSE_SYSTEM,
  proposeChange,
  proposeMessage,
  type Candidate,
  type ProposeContext,
} from './propose.js';
export {
  coachingRegistry,
  ProposeCorrectionArgs,
  proposeCorrectionHandler,
} from './coach-dispatch.js';
export { fakeAgentScript, fakeCoachTriage, fakeProposal } from './fake-coach.js';
export {
  applyHoursWith,
  COACH_TEXTS,
  explain,
  reanswer,
  runCoachingTurn,
  type CoachDeps,
  type CoachOutcome,
  type CoachTurnInput,
  type CoachTurnResult,
  type ExplainedFact,
  type Explainer,
  type ReasonCode,
  type VisitorsWouldGet,
} from './coach.js';
export {
  appendMessages,
  CoachingSessionNotFoundError,
  createSession,
  getMessage as getCoachingMessage,
  getSession,
  InvalidSessionCursorError,
  listSessions,
  sessionMessages,
  SESSIONS_PAGE,
  type CoachingMessageRow,
  type CoachingOrigin,
  type CoachingSessionRow,
} from './coach-store.js';
export {
  abuseTurns,
  effectsOf,
  replayContext,
  ReplayPorts,
  replayRegistry,
  stubAll,
  type ReplayEffect,
} from './replay-dispatch.js';
export {
  CANDIDATES_PAGE,
  ConversationGoneError,
  getReplay,
  InvalidReplayCursorError,
  NothingToReplayError,
  REPLAY_LIMIT,
  replayCandidates,
  ReplayCompleteError,
  ReplayConversationNotFoundError,
  replayNext,
  replayQuestion,
  startReplay,
  type OriginalReplyRow,
  type ReplayCandidateRow,
  type ReplayDeps,
  type ReplayQuestionInput,
  type ReplayTurnRow,
  type ReplayView,
} from './replay.js';
export {
  correctionReplayNext,
  CorrectionReplayNotFoundError,
  getCorrectionReplay,
  startCorrectionReplay,
  type CorrectionReplayTurnRow,
  type CorrectionReplayView,
} from './correction-replay.js';
