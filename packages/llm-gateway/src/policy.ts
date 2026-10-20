/**
 * The ModelRouter's reply policy (ADR-007 decisions 1 and 3). Provider-neutral: the
 * agent derives the signals from its turn plan (FEAT-004 D1), and the tenant's
 * thresholds and cost-governor step come from tenant configuration (D10).
 */
export interface RoutePolicy {
  /** Complexity at or above this goes to the larger model. */
  complexityThreshold: number;
  /** Triage confidence below this goes to the larger model. */
  minConfidence: number;
  /** Cost-governor steps (0..MAX_GOVERNOR_STEP); each raises the complexity threshold. */
  governorStep: number;
}

export interface RouteSignals {
  /** 0..1 from triage. */
  complexity: number;
  /** 0..1 from triage. */
  confidence: number;
  /** The plan holds a task that always needs the larger model (a commitment, `draft_approval`). */
  complexTask: boolean;
  complaint: boolean;
  /** The reply failed verification once (ADR-007: regenerations go to the larger model). */
  regeneration: boolean;
}

export const GOVERNOR_STEP = 0.1;
export const MAX_GOVERNOR_STEP = 3;
/** A fully raised tenant still sends its clearly complex turns to Sonnet (D8). */
export const MAX_COMPLEXITY_THRESHOLD = 0.95;
export const DEFAULT_ROUTE_POLICY: RoutePolicy = {
  complexityThreshold: 0.6,
  minConfidence: 0.5,
  governorStep: 0,
};

export function effectiveThreshold(p: RoutePolicy): number {
  const step = Math.min(Math.max(Math.trunc(p.governorStep), 0), MAX_GOVERNOR_STEP);
  // Rounded so 0.6 + 3 × 0.1 compares as 0.9, not 0.8999999.
  const raised = Math.round((p.complexityThreshold + step * GOVERNOR_STEP) * 1000) / 1000;
  return Math.min(raised, MAX_COMPLEXITY_THRESHOLD);
}

/**
 * Haiku for simple grounded turns, Sonnet for commitments, complaints, low confidence,
 * regenerations and complex turns. The governor moves only the complexity threshold (D8).
 */
export function routeReply(s: RouteSignals, p: RoutePolicy): 'reply.simple' | 'reply.complex' {
  if (s.regeneration || s.complexTask || s.complaint) return 'reply.complex';
  if (s.confidence < p.minConfidence) return 'reply.complex';
  return s.complexity >= effectiveThreshold(p) ? 'reply.complex' : 'reply.simple';
}
