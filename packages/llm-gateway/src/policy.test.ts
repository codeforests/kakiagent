import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE_POLICY,
  effectiveThreshold,
  routeReply,
  type RoutePolicy,
  type RouteSignals,
} from './index.js';

const simple: RouteSignals = {
  complexity: 0.2,
  confidence: 0.9,
  complexTask: false,
  complaint: false,
  regeneration: false,
};
const policy = (p: Partial<RoutePolicy> = {}): RoutePolicy => ({ ...DEFAULT_ROUTE_POLICY, ...p });

describe('routeReply (ADR-007 decision 1, FEAT-004 AC-2)', () => {
  it('sends a simple, confident turn to Haiku', () => {
    expect(routeReply(simple, policy())).toBe('reply.simple');
  });

  it.each([
    ['complexity at the threshold', { complexity: 0.6 }],
    ['complexity above the threshold', { complexity: 0.9 }],
    ['low confidence', { confidence: 0.4 }],
    ['a commitment task', { complexTask: true }],
    ['a complaint', { complaint: true }],
    ['a regeneration', { regeneration: true }],
  ])('sends %s to Sonnet', (_, s) => {
    expect(routeReply({ ...simple, ...s }, policy())).toBe('reply.complex');
  });

  it("uses the tenant's own thresholds", () => {
    const s = { ...simple, complexity: 0.5, confidence: 0.6 };
    expect(routeReply(s, policy())).toBe('reply.simple');
    expect(routeReply(s, policy({ complexityThreshold: 0.4 }))).toBe('reply.complex');
    expect(routeReply(s, policy({ minConfidence: 0.7 }))).toBe('reply.complex');
  });

  it('raises the complexity threshold 0.1 per governor step, capped at 0.95', () => {
    expect([0, 1, 2, 3].map((governorStep) => effectiveThreshold(policy({ governorStep })))).toEqual(
      [0.6, 0.7, 0.8, 0.9],
    );
    expect(effectiveThreshold(policy({ complexityThreshold: 0.8, governorStep: 3 }))).toBe(0.95);
    expect(effectiveThreshold(policy({ governorStep: 9 }))).toBe(0.9);
    const turn = { ...simple, complexity: 0.75 };
    expect(routeReply(turn, policy({ governorStep: 1 }))).toBe('reply.complex');
    expect(routeReply(turn, policy({ governorStep: 2 }))).toBe('reply.simple');
  });

  it('keeps commitments, complaints, low confidence and regenerations on Sonnet at any step (D8)', () => {
    const raised = policy({ governorStep: 3 });
    for (const s of [
      { complexTask: true },
      { complaint: true },
      { confidence: 0.1 },
      { regeneration: true },
      { complexity: 1 },
    ])
      expect(routeReply({ ...simple, ...s }, raised)).toBe('reply.complex');
  });
});
