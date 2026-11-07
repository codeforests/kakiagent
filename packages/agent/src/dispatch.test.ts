import { isAboveMax, SAFE_DEFAULTS, type BoundaryRules } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRegistry,
  dispatchPlan,
  dispatchToolCall,
  OutOfScopeArgs,
  visitorRegistry,
  type ConversationPort,
  type DispatchAuditEntry,
  type DispatchContext,
  type TaskHandler,
} from './dispatch.js';
import { prefillOf } from './lead.js';
import { replayRegistry } from './replay-dispatch.js';
import { parsePlan, type TaskKind, type TurnPlan } from './plan.js';

function planOf(tasks: [TaskKind, Record<string, string>?][]): TurnPlan {
  // A plan as triage writes it, without the FEAT-025 impersonation flag: it defaults to false.
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

/** An in-memory conversation port that records what handlers did (FEAT-025 §5.2). */
function memoryConversation(
  failFlag = false,
  offer: { held: boolean; offers: boolean; withdrawn: boolean } = {
    held: true,
    offers: false,
    withdrawn: false,
  },
) {
  const state = {
    flags: [] as string[],
    abuseTurns: new Set<string>(),
    ended: false,
    escalations: [] as string[],
    requests: [] as unknown[],
  };
  const port: ConversationPort = {
    async flag(reason) {
      if (failFlag) throw new Error('db down');
      if (!state.flags.includes(reason)) state.flags.push(reason);
    },
    async recordAbuse(turnId) {
      state.abuseTurns.add(turnId);
      return state.abuseTurns.size;
    },
    async endAi() {
      state.ended = true;
    },
    async escalate(source) {
      state.escalations.push(source);
      return { status: 'escalated' as const };
    },
    async withdrawalOffer() {
      return offer;
    },
    async draftApproval(request) {
      state.requests.push(request);
      return {
        status: state.requests.length > 1 ? ('already_pending' as const) : ('drafted' as const),
        approvalId: 'apr-1',
        slaDueAt: new Date('2026-11-05T06:30:00Z'),
        afterHours: false,
      };
    },
  };
  return { state, port };
}

function context(
  over: Partial<DispatchContext> = {},
  offer?: { held: boolean; offers: boolean; withdrawn: boolean },
) {
  const audits: DispatchAuditEntry[] = [];
  const memory = memoryConversation(false, offer);
  const ctx: DispatchContext = {
    scope: 'visitor',
    tenantId: 't',
    conversationId: 'c',
    turnId: 'turn-1',
    gateOpen: async () => true,
    consentGiven: async () => true,
    boundaryRules: async () => ({ ...SAFE_DEFAULTS, maxDiscountPct: 10 }),
    audit: async (e) => {
      audits.push(e);
    },
    conversation: memory.port,
    ...over,
  };
  return { ctx, audits, conversation: memory.state };
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

  it('reports every task without a handler unhandled in the production registry, and never the answer', async () => {
    const { ctx, audits } = context();
    const { reports, endTurn } = await dispatchPlan(
      visitorRegistry,
      planOf([['answer'], ['handoff_channel', { phone: '9123 4567' }]]),
      ctx,
    );
    expect(endTurn).toBeUndefined();
    // FEAT-051 handles `data_request`; `handoff_channel` waits for FEAT-038.
    expect(reports).toEqual([{ task: 'handoff_channel', index: 1, outcome: 'unhandled' }]);
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
      // FEAT-054: the handler decides from the rules in force (here: a 20% discount above
      // the 0% maximum; since FEAT-055 D1 `commitmentDecision` sends that to approval).
      {
        checkBoundary: (rules: BoundaryRules) => !isAboveMax(rules, { discountPct: 20 }),
      },
      {},
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
      handler('crisis', ran, { run: async () => ({ endTurn: { key: 'crisis' } }) }),
      handler('capture_lead', ran),
    ]);
    const { ctx, audits } = context();
    const out = await dispatchPlan(reg, planOf([['capture_lead'], ['crisis']]), ctx);
    expect(out.endTurn).toEqual({ key: 'crisis' });
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

describe('the out_of_scope handler (FEAT-023 AC-4)', () => {
  it('is done in visitor scope and adds the refusal key once, after safety', async () => {
    const { ctx, audits } = context();
    const { reports, replies } = await dispatchPlan(
      visitorRegistry,
      planOf([['out_of_scope'], ['answer'], ['escalate'], ['out_of_scope']]),
      ctx,
    );
    expect(reports).toEqual([
      { task: 'out_of_scope', index: 0, outcome: 'done' },
      { task: 'escalate', index: 2, outcome: 'done' },
      { task: 'out_of_scope', index: 3, outcome: 'done' },
    ]);
    expect(replies).toEqual(['out_of_scope']);
    expect(audits[0]).toEqual({ task: 'out_of_scope', outcome: 'done' });
  });

  it('also runs in coaching scope (FEAT-027, UC-04 2a); refused with the gate closed', async () => {
    const coaching = context();
    const r1 = await dispatchPlan(visitorRegistry, planOf([['out_of_scope']]), {
      ...coaching.ctx,
      scope: 'coaching',
    });
    expect(r1).toMatchObject({ replies: ['out_of_scope'], reports: [{ outcome: 'done' }] });
    // The safety handlers stay visitor-only.
    const r3 = await dispatchPlan(visitorRegistry, planOf([['crisis']]), {
      ...coaching.ctx,
      scope: 'coaching',
    });
    expect(r3).toMatchObject({ reports: [{ outcome: 'refused', reason: 'scope' }] });
    const closed = context({ gateOpen: async () => false });
    const r2 = await dispatchPlan(visitorRegistry, planOf([['out_of_scope']]), closed.ctx);
    expect(r2.replies).toEqual([]);
  });
});

describe('the safety handlers (FEAT-025 AC-6, AC-7; ADR-025 decision 6)', () => {
  it('crisis flags the conversation and ends the turn before any state task or answer', async () => {
    const conv = memoryConversation();
    const { ctx, audits } = context({ conversation: conv.port });
    const out = await dispatchPlan(
      visitorRegistry,
      planOf([['answer'], ['out_of_scope'], ['crisis']]),
      ctx,
    );
    expect(out.endTurn).toEqual({ key: 'crisis' });
    expect(out.replies).toEqual([]);
    expect(conv.state).toMatchObject({ flags: ['crisis'], ended: false });
    expect(audits).toEqual([{ task: 'crisis', outcome: 'done' }]);
  });

  it('crisis still ends the turn with the contacts when the flag cannot be stored', async () => {
    const { ctx, audits } = context({ conversation: memoryConversation(true).port });
    const out = await dispatchPlan(visitorRegistry, planOf([['crisis']]), ctx);
    expect(out.endTurn).toEqual({ key: 'crisis' });
    expect(out.reports).toEqual([{ task: 'crisis', index: 0, outcome: 'failed' }]);
    expect(audits).toEqual([{ task: 'crisis', outcome: 'failed' }]);
  });

  it('abuse warns on the first turn, then flags and ends the AI on the second; a redelivered turn counts once', async () => {
    const conv = memoryConversation();
    const first = context({ conversation: conv.port, turnId: 'm1' });
    const out1 = await dispatchPlan(visitorRegistry, planOf([['abuse'], ['answer']]), first.ctx);
    expect(out1.endTurn).toEqual({ key: 'abuse_warning' });
    const again = await dispatchPlan(visitorRegistry, planOf([['abuse']]), first.ctx);
    expect(again.endTurn).toEqual({ key: 'abuse_warning' });
    expect(conv.state).toMatchObject({ flags: [], ended: false });
    const second = context({ conversation: conv.port, turnId: 'm2' });
    const out2 = await dispatchPlan(visitorRegistry, planOf([['abuse']]), second.ctx);
    expect(out2.endTurn).toEqual({ key: 'abuse_ended' });
    expect(conv.state).toMatchObject({ flags: ['abuse'], ended: true });
  });

  it('the visitor registry has no owner function (AC-5; ADR-009)', () => {
    // `escalate` (FEAT-044) asks for a person for this conversation; `capture_lead` (FEAT-049)
    // returns a card for the visitor's own details; `request_commitment` (FEAT-055) drafts an
    // approval for this conversation; `withdraw_consent` (FEAT-051) returns a card and
    // `data_request` escalates this conversation. None reads or changes other tenant data.
    expect([...visitorRegistry.byKind.keys()].sort()).toEqual([
      'abuse',
      'capture_lead',
      'crisis',
      'data_request',
      'escalate',
      'out_of_scope',
      'request_commitment',
      'withdraw_consent',
    ]);
    expect([...visitorRegistry.byTool.keys()]).toEqual(['draft_approval']);
  });
});

describe('out_of_scope topics (FEAT-025 AC-8, D3)', () => {
  it.each([
    ['medical', 'advice'],
    ['legal', 'advice'],
    ['financial', 'advice'],
    ['illegal', 'illegal'],
    ['other', 'out_of_scope'],
    ['astrology', 'out_of_scope'],
  ])('topic %s gets the %s text', async (topic, key) => {
    const { ctx } = context();
    const out = await dispatchPlan(visitorRegistry, planOf([['out_of_scope', { topic }]]), ctx);
    expect(out.reports).toEqual([{ task: 'out_of_scope', index: 0, outcome: 'done' }]);
    expect(out.replies).toEqual([key]);
  });

  it('never refuses the task over its arguments', () => {
    expect(OutOfScopeArgs.parse(42)).toEqual({ topic: 'other' });
    expect(OutOfScopeArgs.parse({})).toEqual({ topic: 'other' });
  });
});

describe('the escalate handler (FEAT-044 §5.4; AC-2)', () => {
  it('asks the port for a person, adds no reply key, and is audited', async () => {
    const { ctx, audits, conversation } = context();
    const { reports, replies } = await dispatchPlan(
      visitorRegistry,
      planOf([['answer'], ['escalate']]),
      ctx,
    );
    expect(reports).toEqual([{ task: 'escalate', index: 1, outcome: 'done' }]);
    expect(replies).toEqual([]);
    expect(conversation.escalations).toEqual(['visitor_asked']);
    expect(audits).toEqual([{ task: 'escalate', outcome: 'done' }]);
  });

  it('is refused in coaching scope and with the gate closed; nothing escalates', async () => {
    const coaching = context();
    const r = await dispatchPlan(visitorRegistry, planOf([['escalate']]), {
      ...coaching.ctx,
      scope: 'coaching',
    });
    expect(r.reports).toEqual([
      { task: 'escalate', index: 0, outcome: 'refused', reason: 'scope' },
    ]);
    const closed = context({ gateOpen: async () => false });
    const r2 = await dispatchPlan(visitorRegistry, planOf([['escalate']]), closed.ctx);
    expect(r2.reports[0]).toMatchObject({ outcome: 'refused', reason: 'gate_closed' });
    expect(coaching.conversation.escalations).toEqual([]);
    expect(closed.conversation.escalations).toEqual([]);
  });
});

describe('request_commitment (FEAT-055 §5.2; AC-1, AC-11)', () => {
  it('drafts through the port with the parsed args, audited with the tool, no reply key', async () => {
    const { ctx, audits, conversation } = context();
    const { reports, replies } = await dispatchPlan(
      visitorRegistry,
      planOf([
        ['answer'],
        ['request_commitment', { items: 'vanilla cupcakes', quantity: '200', discount: '15%' }],
      ]),
      ctx,
    );
    expect(reports).toEqual([{ task: 'request_commitment', index: 1, outcome: 'done' }]);
    expect(replies).toEqual([]);
    expect(conversation.requests).toEqual([
      { items: 'vanilla cupcakes', quantity: '200', discount: '15%' },
    ]);
    // Codes only: never the request or the amounts.
    expect(audits).toEqual([
      { task: 'request_commitment', tool: 'draft_approval', outcome: 'done' },
    ]);
  });

  it('an above-maximum discount still goes to approval (D1); a number quantity is a string', async () => {
    const { ctx, conversation } = context();
    const { reports } = await dispatchPlan(
      visitorRegistry,
      parsePlan(
        JSON.stringify({
          language: 'en',
          register: 'standard',
          complexity: 0.8,
          confidence: 0.9,
          flags: { complaint: false, injection: false },
          tasks: [{ kind: 'request_commitment', args: { quantity: 50, discount: 40 } }],
        }),
      ),
      ctx,
    );
    expect(reports[0]).toMatchObject({ outcome: 'done' });
    expect(conversation.requests).toEqual([{ quantity: '50', discount: 40 }]);
  });

  it('refuses args of the wrong type, coaching scope and a closed gate; nothing is drafted', async () => {
    const bad = context();
    const r = await dispatchPlan(
      visitorRegistry,
      parsePlan(
        JSON.stringify({
          language: 'en',
          register: 'standard',
          complexity: 0.8,
          confidence: 0.9,
          flags: { complaint: false, injection: false },
          tasks: [{ kind: 'request_commitment', args: { items: true } }],
        }),
      ),
      bad.ctx,
    );
    expect(r.reports[0]).toMatchObject({ outcome: 'refused', reason: 'invalid_args' });
    const coaching = context();
    const c = await dispatchPlan(visitorRegistry, planOf([['request_commitment']]), {
      ...coaching.ctx,
      scope: 'coaching',
    });
    expect(c.reports[0]).toMatchObject({ outcome: 'refused', reason: 'scope' });
    const closed = context({ gateOpen: async () => false });
    const g = await dispatchPlan(visitorRegistry, planOf([['request_commitment']]), closed.ctx);
    expect(g.reports[0]).toMatchObject({ outcome: 'refused', reason: 'gate_closed' });
    expect([bad, coaching, closed].flatMap((x) => x.conversation.requests)).toEqual([]);
  });

  it('replay leaves it out (no draft from a replay)', () => {
    expect(replayRegistry.byKind.has('request_commitment')).toBe(false);
  });
});

describe('capture_lead (FEAT-049 §5.3; AC-7)', () => {
  const CONSENT = '11111111-1111-4111-8111-111111111111';
  const args = { name: ' Mei ', phone: '9123 4567', email: 'not-an-email' };

  it('before consent: refused `consent`, nothing run, codes only in the audit', async () => {
    const { ctx, audits } = context({ consentGiven: async () => false });
    const out = await dispatchPlan(visitorRegistry, planOf([['capture_lead', args]]), ctx);
    expect(out.reports).toEqual([
      { task: 'capture_lead', index: 0, outcome: 'refused', reason: 'consent' },
    ]);
    expect(out.card).toBeUndefined();
    expect(JSON.stringify(audits)).not.toMatch(/Mei|9123/);
  });

  it('after consent: a lead form card with the valid args only, and its reply text', async () => {
    const { ctx } = context({ leadConsentId: async () => CONSENT });
    const out = await dispatchPlan(visitorRegistry, planOf([['capture_lead', args]]), ctx);
    expect(out.reports[0]).toMatchObject({ outcome: 'done' });
    expect(out.card).toEqual({
      kind: 'lead_form',
      consentId: CONSENT,
      prefill: { name: 'Mei', phone: '+6591234567' },
    });
    expect(out.replies).toEqual(['lead_form']);
  });

  it('coaching scope never handles it', async () => {
    const { ctx } = context({ scope: 'coaching', leadConsentId: async () => CONSENT });
    const out = await dispatchPlan(visitorRegistry, planOf([['capture_lead', args]]), ctx);
    expect(out.reports[0]).toMatchObject({ outcome: 'refused', reason: 'scope' });
  });

  it('prefillOf drops what fails the form checks', () => {
    expect(prefillOf({ phone: '1234', email: 'Mei@Example.com', name: 'x'.repeat(121) })).toEqual({
      email: 'mei@example.com',
    });
    expect(prefillOf('nonsense')).toEqual({});
  });
});

describe('withdraw_consent and data_request (FEAT-051 §5.3; AC-2, AC-9)', () => {
  it('held: the confirm card with offers, its reply text, and no write', async () => {
    const { ctx, conversation } = context({}, { held: true, offers: true, withdrawn: false });
    const out = await dispatchPlan(visitorRegistry, planOf([['withdraw_consent']]), ctx);
    expect(out.reports).toEqual([{ task: 'withdraw_consent', index: 0, outcome: 'done' }]);
    expect(out.card).toEqual({ kind: 'withdraw', offers: true });
    expect(out.replies).toEqual(['withdraw_confirm']);
    expect(conversation).toMatchObject({ escalations: [], flags: [], ended: false });
  });

  it('already withdrawn: withdraw_already; nothing held: withdraw_none; no card either way', async () => {
    const done = context({}, { held: true, offers: false, withdrawn: true });
    const a = await dispatchPlan(visitorRegistry, planOf([['withdraw_consent']]), done.ctx);
    expect(a.card).toBeUndefined();
    expect(a.replies).toEqual(['withdraw_already']);
    const none = context({}, { held: false, offers: false, withdrawn: false });
    const b = await dispatchPlan(visitorRegistry, planOf([['withdraw_consent']]), none.ctx);
    expect(b.card).toBeUndefined();
    expect(b.replies).toEqual(['withdraw_none']);
  });

  it('a deletion request escalates with source data_request; with a withdrawal both happen', async () => {
    const { ctx, conversation } = context();
    const out = await dispatchPlan(
      visitorRegistry,
      planOf([['withdraw_consent'], ['data_request']]),
      ctx,
    );
    expect(out.reports.map((r) => [r.task, r.outcome])).toEqual([
      ['withdraw_consent', 'done'],
      ['data_request', 'done'],
    ]);
    expect(out.card).toEqual({ kind: 'withdraw', offers: false });
    expect(out.replies).toEqual(['withdraw_confirm', 'data_request']);
    expect(conversation.escalations).toEqual(['data_request']);
  });

  it('coaching scope and replay never run them', async () => {
    const { ctx, conversation } = context({ scope: 'coaching' });
    const out = await dispatchPlan(
      visitorRegistry,
      planOf([['withdraw_consent'], ['data_request']]),
      ctx,
    );
    expect(out.reports.map((r) => r.reason)).toEqual(['scope', 'scope']);
    expect(conversation.escalations).toEqual([]);
    expect(replayRegistry.byKind.has('withdraw_consent')).toBe(false);
    expect(replayRegistry.byKind.has('data_request')).toBe(false);
  });
});
