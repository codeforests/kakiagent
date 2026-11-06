/**
 * Public interface of the `approvals` module (architecture §5.2): boundary rules
 * (FEAT-054); FEAT-055 adds approvals. Other modules may import only this file
 * (dependency-cruiser enforces it).
 */
export {
  changedFields,
  COMMITMENT_KEYS,
  commitmentDecision,
  currentRules,
  isAboveMax,
  LOCKED_COMMITMENTS,
  normaliseList,
  normaliseRules,
  rulesInForce,
  rulesSaved,
  RulesStale,
  SAFE_DEFAULTS,
  saveRules,
  type BoundaryRules,
  type CommitmentDecision,
  type CommitmentKey,
  type SavedRules,
} from './rules.js';
export {
  cleanRequest,
  draftLines,
  expiredNotice,
  formatSgd,
  headline,
  kindOf,
  MAX_LINES,
  parseDiscount,
  parseQuantity,
  quoteText,
  rejectedNotice,
  tokens,
  totalsOf,
  type ApprovalKind,
  type CommitmentRequest,
  type GstNote,
  type Line,
  type PricedProduct,
  type QuoteTotals,
  type Terms,
} from './quote.js';
export {
  approverIds,
  draftApproval,
  EXPIRY_MS,
  pendingApprovalOf,
  URGENT_MS,
  type ApprovalRow,
  type DraftInput,
  type DraftResult,
} from './drafts.js';
export {
  AlreadyDecided,
  ApprovalExpired,
  ApprovalNotFound,
  decide,
  deliver,
  gstOf,
  InvalidTerms,
  type DecideResult,
  type Decision,
  type Outcome,
} from './decide.js';
export {
  queueApprovalTimers,
  runApprovalTimer,
  type ApprovalTimer,
  type TimerResult,
} from './timers.js';
export {
  approvalById,
  DECIDED_DAYS,
  listApprovals,
  PAGE_SIZE,
  summaryOf,
  termsOf,
  totalsFor,
  type ApprovalSummaryRow,
} from './views.js';
export {
  APPROVAL_LINK_TTL_S,
  ApprovalLinkError,
  approvalLinkKey,
  approvalLinkUrl,
  openApprovalLink,
  readApprovalLink,
  signApprovalLink,
  type ApprovalLinkClaims,
  type ApprovalLinkSubject,
  type LinkOpener,
  type ReadLink,
} from './links.js';
