import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRegistry,
  dispatchPlan,
  dispatchToolCall,
  visitorRegistry,
  type DispatchAuditEntry,
  type DispatchContext,
  type TaskHandler,
} from './dispatch.js';
import { parsePlan, type TaskKind, type TurnPlan } from './plan.js';

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

function context(over: Partial<DispatchContext> = {}) {
  const audits: DispatchAuditEntry[] = [];
  const ctx: DispatchContext = {
    scope: 'visitor',
    tenantId: 't',
    conversationId: 'c',
    turnId: 'turn-1',
    gateOpen: async () => true,
    consentGiven: async () => true,
    boundaryRules: async () => ({ maxDiscountPercent: 10 }),
    audit: async (e) => {
      audits.push(e);
    },
    ...over,
  };
  return { ctx, audits };
}

/** A handler that records its runs. */
function handler(
  kind: TaskHandler['kind'],
  ran: string[],
  over: Partial<TaskHandler<Record<string, unknown>>> = {},
): TaskHandler<Record<string, unknown>> {
  return {
    kind,
    scopes: ['visitor'],
    args: z.record(z.string(), z.unknown()),
    async run(_ctx, _args, key) {
      ran.push(`${kind}@${key}`);
      return {};
    },
    ...over,
  };
}

describe('dispatchPlan (ADR-025 decisions 2 and 6, AC-7)', () => {
  it('runs safety tasks first, then state tasks, in plan order, with turn:index keys', async () => {
    const ran: string[] = [];
    const reg = createRegistry([
      handler('capture_lead', ran),
      handler('abuse', ran),
      handler('escalate', ran),
    ]);
    const { ctx, audits } = context();
    const { reports } = await dispatchPlan(
      reg,
      planOf([['answer'], ['capture_lead'], ['escalate'], ['abuse']]),
      ctx,
    );
    expect(ran).toEqual(['abuse@turn-1:3', 'capture_lead@turn-1:1', 'escalate@turn-1:2']);
    expect(reports.map((r) => [r.task, r.outcome])).toEqual([
      ['abuse', 'done'],
      ['capture_lead', 'done'],
      ['escalate', 'done'],
    ]);
    expect(audits).toEqual([
      { task: 'abuse', outcome: 'done' },
      { task: 'capture_lead', outcome: 'done' },
      { task: 'escalate', outcome: 'done' },
    ]);
  });

  it('reports every task unhandled with the empty production registry, and never the answer', async () => {
    const { ctx, audits } = context();
    const { reports, endTurn } = await dispatchPlan(
      visitorRegistry,
      planOf([['answer'], ['capture_lead', { phone: '9123 4567' }], ['request_commitment']]),
      ctx,
    );
    expect(endTurn).toBeUndefined();
    expect(reports).toEqual([
      { task: 'capture_lead', index: 1, outcome: 'unhandled' },
      { task: 'request_commitment', index: 2, outcome: 'unhandled' },
    ]);
    // Codes only: the phone number in the args never reaches the audit entry.
    expect(JSON.stringify(audits)).not.toContain('9123');
  });

  it.each([
    ['scope', { scopes: ['coaching'] as const }, {}],
    ['gate_closed', {}, { gateOpen: async () => false }],
    ['invalid_args', { args: z.object({ phone: z.string().regex(/^[689]\d{7}$/) }) }, {}],
    ['consent', { needsConsent: true }, { consentGiven: async () => false }],
    ['boundary', { checkBoundary: () => false }, {}],
    [
      'boundary',
      { checkBoundary: (rules: unknown) => rules !== null },
      { boundaryRules: async () => null },
    ],
  ])('refuses with %s and does not run the handler', async (reason, h, c) => {
    const ran: string[] = [];
    const reg = createRegistry([
      handler('capture_lead', ran, h as Partial<TaskHandler<Record<string, unknown>>>),
    ]);
    const { ctx, audits } = context(c);
    const { reports } = await dispatchPlan(reg, planOf([['capture_lead', { phone: 'x' }]]), ctx);
    expect(ran).toEqual([]);
    expect(reports).toEqual([{ task: 'capture_lead', index: 0, outcome: 'refused', reason }]);
    expect(audits).toEqual([{ task: 'capture_lead', outcome: 'refused', reason }]);
  });

  it('a failing task does not drop the next one', async () => {
    const ran: string[] = [];
    const reg = createRegistry([
      handler('capture_lead', ran, {
        run: async () => {
          throw new Error('leads down');
        },
      }),
      handler('escalate', ran),
    ]);
    const { ctx } = context();
    const { reports } = await dispatchPlan(reg, planOf([['capture_lead'], ['escalate']]), ctx);
    expect(reports.map((r) => r.outcome)).toEqual(['failed', 'done']);
    expect(ran).toEqual(['escalate@turn-1:1']);
  });

  it('a safety task can end the turn; later tasks are neither run nor audited', async () => {
    const ran: string[] = [];
    const reg = createRegistry([
      handler('crisis', ran, { run: async () => ({ endTurn: { text: 'crisis contacts' } }) }),
      handler('capture_lead', ran),
    ]);
    const { ctx, audits } = context();
    const out = await dispatchPlan(reg, planOf([['capture_lead'], ['crisis']]), ctx);
    expect(out.endTurn).toEqual({ text: 'crisis contacts' });
    expect(ran).toEqual([]);
    expect(audits).toEqual([{ task: 'crisis', outcome: 'done' }]);
  });

  it('a registry refuses two handlers for one kind or one tool', () => {
    expect(() => createRegistry([handler('escalate', []), handler('escalate', [])])).toThrow(
      /two handlers for escalate/,
    );
    expect(() =>
      createRegistry([
        handler('capture_lead', [], { tool: 'capture_lead' }),
        handler('escalate', [], { tool: 'capture_lead' }),
      ]),
    ).toThrow(/tool capture_lead/);
  });
});

describe('dispatchToolCall (ADR-025 decision 3, AC-7)', () => {
  const ran: string[] = [];
  const reg = createRegistry([
    handler('capture_lead', ran, {
      tool: 'capture_lead',
      args: z.object({ name: z.string() }),
      needsConsent: true,
    }),
  ]);
  const call = (name: string, input: unknown = { name: 'Tan' }) => ({ id: 'tu1', name, input });

  it('runs a tool the plan enabled, with the same checks', async () => {
    const { ctx, audits } = context();
    const out = await dispatchToolCall(
      reg,
      call('capture_lead'),
      planOf([['answer'], ['capture_lead']]),
      ctx,
    );
    expect(out).toMatchObject({ task: 'capture_lead', index: 1, outcome: 'done' });
    expect(audits).toEqual([{ task: 'capture_lead', tool: 'capture_lead', outcome: 'done' }]);
    const refused = await dispatchToolCall(
      reg,
      call('capture_lead', { name: 5 }),
      planOf([['capture_lead']]),
      context().ctx,
    );
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'invalid_args' });
    const noConsent = await dispatchToolCall(
      reg,
      call('capture_lead'),
      planOf([['capture_lead']]),
      context({ consentGiven: async () => false }).ctx,
    );
    expect(noConsent).toMatchObject({ outcome: 'refused', reason: 'consent' });
  });

  it('refuses an unknown tool and a tool whose task is not in the plan', async () => {
    const { ctx, audits } = context();
    expect(
      await dispatchToolCall(reg, call('send_refund'), planOf([['answer']]), ctx),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'scope',
    });
    expect(
      await dispatchToolCall(reg, call('capture_lead'), planOf([['answer']]), ctx),
    ).toMatchObject({
      task: 'capture_lead',
      outcome: 'refused',
      reason: 'not_in_plan',
    });
    expect(audits).toEqual([
      { task: 'answer', tool: 'unknown', outcome: 'refused', reason: 'scope' },
      { task: 'capture_lead', tool: 'capture_lead', outcome: 'refused', reason: 'not_in_plan' },
    ]);
  });
});
