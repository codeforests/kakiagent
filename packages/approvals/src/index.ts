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
