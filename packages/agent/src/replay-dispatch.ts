import {
  createRegistry,
  visitorRegistry,
  type BoundaryRules,
  type ConversationPort,
  type DispatchAuditEntry,
  type DispatchContext,
  type DispatchReport,
  type Registry,
} from './dispatch.js';

/**
 * Replay's dispatch (FEAT-028 §5.1, ADR-025 decision 7): the visitor scope's own
 * handlers, re-scoped to the coaching entry point, over ports that write nothing. A
 * replayed question sees exactly the live decisions (crisis, abuse, out of scope) and
 * their visitor texts, and no flag, abuse count or AI state changes.
 */

/**
 * Each handler re-scoped to `coaching`, its checks and `run` unchanged. `capture_lead` is left
 * out: its cards exist only in the widget (FEAT-049 §5.3, AC-7), so a replay reports it unhandled;
 * so is `request_commitment` (FEAT-055 §5.2): a replay drafts no approval; and FEAT-051's
 * `withdraw_consent` (a widget card) and `data_request` (an escalation).
 */
export function stubAll(reg: Registry): Registry {
  return createRegistry(
    [...reg.byKind.values()]
      .filter(
        (h) =>
          h.kind !== 'capture_lead' &&
          h.kind !== 'request_commitment' &&
          h.kind !== 'withdraw_consent' &&
          h.kind !== 'data_request',
      )
      .map((h) => ({ ...h, scopes: ['coaching'] })),
  );
}

/** The visitor handlers for a replay. No `propose_correction`: a replay never proposes. */
export const replayRegistry: Registry = stubAll(visitorRegistry);

/** What the dispatcher would have done live, as codes (FEAT-028 §3 `ReplayEffect`). */
export interface ReplayEffect {
  task: DispatchReport['task'];
  outcome: 'done' | 'refused' | 'unhandled';
}

export const effectsOf = (reports: DispatchReport[]): ReplayEffect[] =>
  reports.map((r) => ({
    task: r.task,
    // A stubbed port can't fail; a handler that threw is reported as not done.
    outcome: r.outcome === 'failed' ? 'refused' : r.outcome,
  }));

/**
 * The conversation port of a replay: no database handle, so it can't write (§5.1).
 * `recordAbuse` counts this replay's earlier abuse turns, so a repeat ends as it did live.
 */
export class ReplayPorts implements ConversationPort {
  readonly audits: DispatchAuditEntry[] = [];
  constructor(private readonly priorAbuse: number) {}
  async flag(): Promise<void> {}
  async recordAbuse(): Promise<number> {
    return this.priorAbuse + 1;
  }
  async endAi(): Promise<void> {}
  /** A replay escalates nobody (FEAT-044); in coaching scope the handler is refused anyway. */
  async escalate(): Promise<{ status: 'escalated' }> {
    return { status: 'escalated' };
  }
  /** Never called: `withdraw_consent` isn't in the replay registry (FEAT-051). */
  async withdrawalOffer(): Promise<never> {
    throw new Error('a replay withdraws nothing');
  }
  /** Never called: `request_commitment` isn't in the replay registry (FEAT-055). */
  async draftApproval(): Promise<never> {
    throw new Error('a replay drafts no approval');
  }
}

/** Earlier replayed turns whose effects include a done `abuse`. */
export const abuseTurns = (earlier: ReplayEffect[][]): number =>
  earlier.filter((effects) => effects.some((e) => e.task === 'abuse' && e.outcome === 'done'))
    .length;

/** A replay's dispatch context: every port stubbed, gate open (FEAT-027 D5), no coaching port. */
export function replayContext(input: {
  tenantId: string;
  sessionId: string;
  turnId: string;
  ports: ReplayPorts;
  rules: BoundaryRules;
}): DispatchContext {
  return {
    scope: 'coaching',
    tenantId: input.tenantId,
    conversationId: input.sessionId,
    turnId: input.turnId,
    gateOpen: async () => true,
    consentGiven: async () => false,
    boundaryRules: async () => input.rules,
    audit: async (e) => {
      input.ports.audits.push(e);
    },
    conversation: input.ports,
  };
}
