import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  scriptedOutputs,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import { answerTurn, replyPlan, type AnswerInput } from './answer.js';
import type { ReplyKey } from './dispatch.js';
import { FALLBACK_PLAN, type TaskKind, type TurnPlan } from './plan.js';
import { assignRefs } from './slots.js';
import { FUDGE } from './testing/facts.js';

const P = assignRefs([FUDGE]).refOf.get(FUDGE.id)!;

function plan(kinds: TaskKind[], confidence = 0.9): TurnPlan {
  return {
    language: 'en',
    register: 'standard',
    complexity: 0.2,
    confidence,
    flags: { complaint: false, injection: false, impersonation: false },
    tasks: kinds.map((kind) => ({ kind, args: {} })),
    fallback: false,
  };
}

describe('replyPlan (FEAT-023 AC-4, AC-5; D1, D9)', () => {
  const oos: ReplyKey[] = ['out_of_scope'];
  it('answers out-of-scope-only plans with the fixed refusal and no model call', () => {
    expect(
      replyPlan({ plan: plan(['out_of_scope']), factCount: 3, minConfidence: 0.5, replies: oos }),
    ).toEqual({ compose: false, lead: 'out_of_scope', closing: [] });
  });

  it('composes a mixed plan and closes with the refusal', () => {
    expect(
      replyPlan({
        plan: plan(['answer', 'out_of_scope']),
        factCount: 1,
        minConfidence: 0.5,
        replies: oos,
      }),
    ).toEqual({ compose: true, lead: null, closing: oos });
  });

  it('says it is unsure with low confidence and no facts', () => {
    expect(
      replyPlan({ plan: plan(['answer'], 0.3), factCount: 0, minConfidence: 0.5, replies: [] }),
    ).toEqual({ compose: false, lead: 'unsure', closing: [] });
    expect(
      replyPlan({ plan: FALLBACK_PLAN, factCount: 0, minConfidence: 0.5, replies: [] }).lead,
    ).toBe('unsure');
  });

  it('composes when confident without facts, or unsure with facts', () => {
    expect(
      replyPlan({ plan: plan(['answer'], 0.5), factCount: 0, minConfidence: 0.5, replies: [] })
        .compose,
    ).toBe(true);
    expect(
      replyPlan({ plan: plan(['answer'], 0.1), factCount: 2, minConfidence: 0.5, replies: [] })
        .compose,
    ).toBe(true);
  });

  it('leaves a plan with no answer and no reply key to the model, as before', () => {
    expect(
      replyPlan({ plan: plan(['escalate']), factCount: 0, minConfidence: 0.5, replies: [] }),
    ).toEqual({ compose: true, lead: null, closing: [] });
  });
});

describe('answerTurn', () => {
  function run(
    over: Partial<AnswerInput>,
    gate = true,
    outputs = ['The [[f:P.name]] is [[f:P.price]].'],
  ) {
    const calls: GenerateRequest[] = [];
    const llm = createGateway(defaultRegistry('fake'), [
      createFakeProvider((req) => {
        calls.push(req);
        return scriptedOutputs(outputs.map((o) => o.replaceAll('f:P', `f:${P}`)))(req);
      }),
    ]);
    const published: { seq: number; text: string }[] = [];
    const input: AnswerInput = {
      facts: [FUDGE],
      history: [{ role: 'user', content: 'how much is the fudge cake?' }],
      businessName: 'Kaki Bakery',
      gstRegistered: true,
      meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
      plan: plan(['answer']),
      replies: [],
      minConfidence: 0.5,
      ...over,
    };
    return answerTurn(input, {
      llm,
      gateOpen: async () => gate,
      publish: async (s) => void published.push(s),
    }).then((result) => ({ result, published, calls }));
  }

  it('sends the refusal in the reply language without calling the model', async () => {
    const { result, published, calls } = await run({
      plan: plan(['out_of_scope']),
      replies: ['out_of_scope'],
      language: 'zh',
    });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ outcome: 'out_of_scope', composed: false, attempts: 0 });
    expect(published).toEqual([{ seq: 0, text: '抱歉，我只能回答与 Kaki Bakery 有关的问题。' }]);
  });

  it('closes a verified answer with the refusal, and tells the model to answer only that part', async () => {
    const { result, published, calls } = await run({
      plan: plan(['answer', 'out_of_scope']),
      replies: ['out_of_scope'],
    });
    expect(result.outcome).toBe('answered');
    expect(published.map((p) => p.text)).toEqual([
      'The Chocolate fudge cake is S$55.00.',
      'Sorry, I can only help with questions about Kaki Bakery.',
    ]);
    expect(published.map((p) => p.seq)).toEqual([0, 1]);
    expect(result.text).toBe(
      'The Chocolate fudge cake is S$55.00. Sorry, I can only help with questions about Kaki Bakery.',
    );
    expect(calls[0]!.tail).toContain('answer only the part that is');
  });

  it('says it is unsure with no facts and low confidence', async () => {
    const { result, calls } = await run({ plan: plan(['answer'], 0.2), facts: [] });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'unsure',
      text: "I'm not sure about that, so I'll check with the team and get back to you.",
    });
  });

  it('releases nothing when the gate is closed', async () => {
    const { result, published } = await run(
      {
        plan: plan(['out_of_scope']),
        replies: ['out_of_scope'],
      },
      false,
    );
    expect(result).toMatchObject({ outcome: 'gate_closed', text: '' });
    expect(published).toEqual([]);
  });
});
