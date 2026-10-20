import {
  createGateway,
  defaultRegistry,
  createFakeProvider,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import { describe, expect, it } from 'vitest';
import { fakeAgentScript, fakeTriage } from './fake-triage.js';
import {
  FALLBACK_PLAN,
  parsePlan,
  routeSignals,
  triage,
  TRIAGE_HISTORY,
  TRIAGE_OUTPUT_SCHEMA,
  TRIAGE_SYSTEM,
  type TurnPlan,
} from './plan.js';

const meta = { tenantId: '11111111-1111-4111-8111-111111111111', conversationId: 'c', turnId: 't' };
const plan = (over: Record<string, unknown> = {}) => ({
  language: 'en',
  register: 'singlish',
  complexity: 0.8,
  confidence: 0.9,
  flags: { complaint: false, injection: false },
  tasks: [
    { kind: 'answer', args: [] },
    {
      kind: 'request_commitment',
      args: [
        { name: 'items', value: 'kueh' },
        { name: 'quantity', value: '50' },
      ],
    },
  ],
  ...over,
});

function gatewayReturning(text: string | Error, stopReason: 'end' | 'refusal' = 'end') {
  const seen: GenerateRequest[] = [];
  const fake = createFakeProvider(() => (text instanceof Error ? '' : text));
  const gw = createGateway(defaultRegistry('fake'), [
    {
      ...fake,
      async generate(req, id) {
        seen.push(req);
        if (text instanceof Error) throw text;
        return { ...(await fake.generate(req, id)), stopReason };
      },
    },
  ]);
  return { gw, seen };
}

describe('parsePlan (ADR-025 decision 1, AC-1)', () => {
  it('parses a multi-task plan in the wire shape into args records', () => {
    const p = parsePlan(JSON.stringify(plan()));
    expect(p.fallback).toBe(false);
    expect(p.tasks).toEqual([
      { kind: 'answer', args: {} },
      { kind: 'request_commitment', args: { items: 'kueh', quantity: '50' } },
    ]);
    expect(p.register).toBe('singlish');
  });

  it('also accepts args as an object', () => {
    const p = parsePlan(
      JSON.stringify(plan({ tasks: [{ kind: 'escalate', args: { why: 'x' } }] })),
    );
    expect(p.tasks).toEqual([{ kind: 'escalate', args: { why: 'x' } }]);
  });

  it.each([
    ['invalid JSON', '{"language": "en",'],
    ['a schema violation', JSON.stringify(plan({ complexity: 3 }))],
    [
      'an unknown task kind',
      JSON.stringify(plan({ tasks: [{ kind: 'refund', args: [] }] as never })),
    ],
    ['an empty task list', JSON.stringify(plan({ tasks: [] }))],
    ['seven tasks', JSON.stringify(plan({ tasks: Array(7).fill({ kind: 'answer', args: [] }) }))],
    ['not an object', '"answer"'],
  ])('falls back on %s', (_, text) => {
    expect(parsePlan(text)).toBe(FALLBACK_PLAN);
  });

  it('the fallback answers only, with confidence 0, and routes complex', () => {
    expect(FALLBACK_PLAN.tasks).toEqual([{ kind: 'answer', args: {} }]);
    expect(FALLBACK_PLAN.confidence).toBe(0);
    expect(routeSignals(FALLBACK_PLAN, false).confidence).toBe(0);
  });
});

describe('triage (ADR-007 decision 1)', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `m${i}`,
  }));

  it('sends a tenant-free structured request with the recent history', async () => {
    const { gw, seen } = gatewayReturning(JSON.stringify(plan()));
    const p = await triage(gw, { history, meta });
    expect(p.tasks.map((t) => t.kind)).toEqual(['answer', 'request_commitment']);
    expect(seen[0]).toMatchObject({
      model: 'triage',
      system: TRIAGE_SYSTEM,
      outputSchema: TRIAGE_OUTPUT_SCHEMA,
      meta,
    });
    expect(seen[0]!.messages).toEqual(history.slice(-TRIAGE_HISTORY));
    expect(seen[0]!.tail).toBeUndefined();
  });

  it('falls back on a provider error and on a refusal', async () => {
    expect(await triage(gatewayReturning(new Error('down')).gw, { history, meta })).toBe(
      FALLBACK_PLAN,
    );
    expect(
      await triage(gatewayReturning(JSON.stringify(plan()), 'refusal').gw, { history, meta }),
    ).toBe(FALLBACK_PLAN);
  });

  it('the output schema closes every object and carries no numeric bounds', () => {
    const json = JSON.stringify(TRIAGE_OUTPUT_SCHEMA);
    expect(json).not.toMatch(/minimum|maximum|minItems|maxItems|maxLength/);
    const objects = json.match(/"type":"object"/g)!.length;
    expect(json.match(/"additionalProperties":false/g)!.length).toBe(objects);
  });
});

describe('routeSignals', () => {
  it('marks commitments and complaints, and passes regeneration through', () => {
    const p = parsePlan(JSON.stringify(plan({ flags: { complaint: true, injection: false } })));
    expect(routeSignals(p, true)).toEqual({
      complexity: 0.8,
      confidence: 0.9,
      complexTask: true,
      complaint: true,
      regeneration: true,
    });
    const simple = parsePlan(JSON.stringify(plan({ tasks: [{ kind: 'answer', args: [] }] })));
    expect(routeSignals(simple, false).complexTask).toBe(false);
  });
});

describe('fake triage (local development and E2E)', () => {
  const run = (text: string) =>
    parsePlan(
      fakeTriage({
        model: 'triage',
        system: '',
        messages: [{ role: 'user', content: text }],
        maxTokens: 1,
        meta,
      }),
    );

  it.each([
    ['what time do you open?', ['answer'], 0.2],
    [
      'how much for 50 kueh, can deliver Saturday? my number is 9123 4567',
      ['answer', 'request_commitment', 'capture_lead'],
      0.8,
    ],
    ['can I talk to a person', ['escalate'], 0.2],
    ['please stop contacting me', ['withdraw_consent'], 0.2],
    ['蛋糕多少钱？', ['answer'], 0.2],
  ])('%s → %j', (text, kinds, complexity) => {
    const p = run(text);
    expect(p.fallback).toBe(false);
    expect(p.tasks.map((t) => t.kind)).toEqual(kinds);
    expect(p.complexity).toBe(complexity);
  });

  it('detects Singlish, Chinese and complaints', () => {
    expect(run('got eggless cake or not lah').register).toBe('singlish');
    expect(run('有没有无蛋蛋糕').language).toBe('zh');
    expect(run('your cake was terrible, I want a refund').flags.complaint).toBe(true);
  });

  it('fakeAgentScript triages triage requests and answers the rest', () => {
    const base = {
      system: '',
      messages: [{ role: 'user' as const, content: 'hi?' }],
      maxTokens: 1,
      meta,
    };
    expect(() => JSON.parse(fakeAgentScript({ ...base, model: 'triage' }))).not.toThrow();
    expect(fakeAgentScript({ ...base, model: 'reply.simple' })).toMatch(/check with the team/);
  });
});
