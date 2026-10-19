/**
 * Public interface of the `agent` module (architecture §5.2): the visitor turn and its
 * verified-segment pipeline (ADR-008, ADR-009). Calls models only through llm-gateway.
 */
export { runVisitorTurn, type TurnDeps, type TurnOutcome, type TurnResult } from './turn.js';
export {
  composeReply,
  MAX_REGENERATIONS,
  type ComposeOutcome,
  type ComposeResult,
} from './compose.js';
export { fakeVisitorResponder } from './fake-responder.js';
export { aiAllowed, type GateResult } from './gate.js';
export { formatSgd, renderPrice, renderSegment, SG_GST_PERCENT, withGst } from './render.js';
export { verifySegment, type Violation, type ViolationKind } from './verify.js';
export { assignRefs } from './slots.js';
export { texts } from './texts.js';
