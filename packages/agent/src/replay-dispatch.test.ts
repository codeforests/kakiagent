import { SAFE_DEFAULTS } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import { explain } from './coach.js';
import { dispatchPlan, dispatchToolCall } from './dispatch.js';
import { parsePlan, type TaskKind, type TurnPlan } from './plan.js';
import {
  abuseTurns,
  effectsOf,
  replayContext,
  ReplayPorts,
  replayRegistry,
} from './replay-dispatch.js';

function planOf(tasks: [TaskKind, Record<string, string>?][]): TurnPlan {
  return parsePlan(
    JSON.stringify({
      language: 'en',
      register: 'standard',
      complexity: 0.5,
      confidence: 0.9,
      flags: { complaint: false, injection: false },
      tasks: tasks.map(([kind, args]) => ({ kind, args: args ?? {} })),
    }),
  );
}

/** A port that fails the test if anything tries to write through it. */
class WatchedPorts extends ReplayPorts {
  writes: string[] = [];
  override async flag() {
    this.writes.push('flag');
  }
  override async endAi() {
    this.writes.push('endAi');
  }
}

const ctxOf = (ports: ReplayPorts) =>
  replayContext({ tenantId: 't', sessionId: 's', turnId: 'm-1', ports, rules: SAFE_DEFAULTS });

const explainFor = (plan: TurnPlan, safety?: 'crisis' | 'abuse_warning' | 'abuse_ended') =>
  explain({
    plan,
    ...(safety ? { safety } : {}),
    facts: [],
    answer: null,
    outcome: 'answered',
    replies: [],
    route: null,
    minConfidence: 0.5,
    aiPaused: false,
    channelLive: true,
  });

describe('replay dispatch (FEAT-028 §5.1, ADR-025 decision 7)', () => {
  it('a crisis plan ends the turn with the crisis text and writes nothing', async () => {
    const ports = new ReplayPorts(0);
    const plan = planOf([['crisis'], ['answer']]);
    const r = await dispatchPlan(replayRegistry, plan, ctxOf(ports));
    expect(r.endTurn).toEqual({ key: 'crisis' });
    expect(effectsOf(r.reports)).toEqual([{ task: 'crisis', outcome: 'done' }]);
    expect(ports.audits).toEqual([{ task: 'crisis', outcome: 'done' }]);
    const e = explainFor(plan, 'crisis');
    expect(e.outcome).toBe('ended');
    expect(e.reasons).toContain('crisis');
  });

  it('abuse warns first, then ends on the repeat, from earlier turns’ effects', async () => {
    const plan = planOf([['abuse']]);
    const first = new WatchedPorts(abuseTurns([]));
    const r1 = await dispatchPlan(replayRegistry, plan, ctxOf(first));
    expect(r1.endTurn).toEqual({ key: 'abuse_warning' });
    expect(first.writes).toEqual([]);

    const second = new WatchedPorts(abuseTurns([effectsOf(r1.reports), []]));
    const r2 = await dispatchPlan(replayRegistry, plan, ctxOf(second));
    expect(r2.endTurn).toEqual({ key: 'abuse_ended' });
    // The stub records the calls a live turn would make; the base class writes nowhere.
    expect(second.writes).toEqual(['flag', 'endAi']);
    expect(explainFor(plan, 'abuse_ended').reasons).toContain('abuse_ended');
  });

  it('the base replay port has no writing side', async () => {
    const ports = new ReplayPorts(5);
    await expect(ports.flag()).resolves.toBeUndefined();
    await expect(ports.endAi()).resolves.toBeUndefined();
    await expect(ports.recordAbuse()).resolves.toBe(6);
    // No database handle: the only state is the count and the collected audit entries.
    expect(Object.keys(ports).sort()).toEqual(['audits', 'priorAbuse']);
  });

  it('an out-of-scope plan gives the visitor’s refusal key', async () => {
    const r = await dispatchPlan(
      replayRegistry,
      planOf([['out_of_scope', { topic: 'medical' }], ['answer']]),
      ctxOf(new ReplayPorts(0)),
    );
    expect(r.endTurn).toBeUndefined();
    expect(r.replies).toEqual(['advice']);
    expect(effectsOf(r.reports)).toEqual([{ task: 'out_of_scope', outcome: 'done' }]);
  });

  it('a kind with no handler is unhandled, and propose_correction is refused', async () => {
    const plan = planOf([['correct'], ['capture_lead'], ['answer']]);
    const ports = new ReplayPorts(0);
    const r = await dispatchPlan(replayRegistry, plan, ctxOf(ports));
    expect(effectsOf(r.reports)).toEqual([
      { task: 'correct', outcome: 'unhandled' },
      { task: 'capture_lead', outcome: 'unhandled' },
    ]);
    const call = await dispatchToolCall(
      replayRegistry,
      {
        id: 'x',
        name: 'propose_correction',
        input: { kind: 'add_faq', question: 'q', answer: 'a' },
      },
      plan,
      ctxOf(ports),
    );
    expect(call.outcome).toBe('refused');
  });
});
