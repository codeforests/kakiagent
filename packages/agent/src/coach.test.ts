import { gatewayFromConfig, type GenerateRequest } from '@kaki/llm-gateway';
import type { VisitorFact } from '@kaki/kb';
import { describe, expect, it } from 'vitest';
import { COACH_TRIAGE_SYSTEM } from './coach-prompt.js';
import { coachingRegistry } from './coach-dispatch.js';
import {
  dispatchPlan,
  dispatchToolCall,
  visitorRegistry,
  type DispatchAuditEntry,
  type DispatchContext,
} from './dispatch.js';
import { fakeAgentScript } from './fake-coach.js';
import { parsePlan, triage, TRIAGE_SYSTEM, type TurnPlan } from './plan.js';
import {
  candidatesOf,
  parseProposal,
  PROPOSE_SYSTEM,
  proposeChange,
  type ProposeContext,
} from './propose.js';

const FUDGE: VisitorFact = {
  id: '00000000-0000-4000-8000-000000000f01',
  type: 'product',
  version: 3,
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
const EGGLESS: VisitorFact = {
  id: '00000000-0000-4000-8000-000000000f02',
  type: 'faq',
  version: 1,
  value: { question: 'Do you have eggless cakes?', answer: 'Yes, 3 days ahead.' },
  gstTreatment: null,
};
const PROMO: VisitorFact = {
  id: '00000000-0000-4000-8000-000000000f03',
  type: 'promotion',
  version: 1,
  value: { title: 'Deepavali bundle', details: 'Two boxes of kueh' },
  gstTreatment: null,
  validUntil: null,
};
const HOURS = {
  mon: [{ open: '09:00', close: '18:00' }],
  tue: [{ open: '09:00', close: '18:00' }],
  wed: [{ open: '09:00', close: '18:00' }],
  thu: [{ open: '09:00', close: '18:00' }],
  fri: [{ open: '09:00', close: '18:00' }],
  sat: [{ open: '10:00', close: '14:00' }],
  sun: [],
};
const ctx: ProposeContext = {
  candidates: candidatesOf([FUDGE, EGGLESS, PROMO, FUDGE]),
  hours: HOURS,
  profileVersion: 4,
};

function plan(kinds: string[]): TurnPlan {
  return parsePlan(
    JSON.stringify({
      language: 'en',
      register: 'standard',
      complexity: 0.2,
      confidence: 0.9,
      flags: { complaint: false, injection: false, impersonation: false },
      tasks: kinds.map((kind) => ({ kind, args: {} })),
    }),
  );
}

function dispatchCtx(scope: 'visitor' | 'coaching') {
  const audits: DispatchAuditEntry[] = [];
  const proposed: unknown[] = [];
  const c: DispatchContext = {
    scope,
    tenantId: 't',
    conversationId: 's',
    turnId: 'q',
    gateOpen: async () => true,
    consentGiven: async () => false,
    boundaryRules: async () => null,
    audit: async (e) => void audits.push(e),
    conversation: {
      flag: async () => {},
      recordAbuse: async () => 0,
      endAi: async () => {},
    },
    coaching: {
      propose: async (p) => {
        proposed.push(p);
        return { correctionId: 'corr-1' };
      },
    },
  };
  return { c, audits, proposed };
}

const llm = gatewayFromConfig({ provider: 'fake', fakeScript: fakeAgentScript });
const req = (system: string, content: string): GenerateRequest => ({
  model: system === PROPOSE_SYSTEM ? 'extract' : 'triage',
  system,
  messages: [{ role: 'user', content }],
  maxTokens: 100,
  meta: { tenantId: 't' },
});

describe('coaching triage prompt (ADR-026)', () => {
  it('lists correct; the visitor prompt never does', () => {
    expect(COACH_TRIAGE_SYSTEM).toMatch(/^ {2}correct: /m);
    expect(TRIAGE_SYSTEM).not.toMatch(/correct:/);
    expect(COACH_TRIAGE_SYSTEM.endsWith(TRIAGE_SYSTEM.split('\n').at(-1)!)).toBe(true);
  });

  it('the fake routes corrections to correct, and questions as a visitor would', async () => {
    const meta = { tenantId: 't' };
    const p1 = await triage(llm, {
      history: [{ role: 'user', content: 'Fudge cake went up to $58' }],
      meta,
      system: COACH_TRIAGE_SYSTEM,
    });
    expect(p1.tasks.map((t) => t.kind)).toEqual(['correct']);
    const p2 = await triage(llm, {
      history: [{ role: 'user', content: 'How much is the fudge cake?' }],
      meta,
      system: COACH_TRIAGE_SYSTEM,
    });
    expect(p2.tasks.map((t) => t.kind)).toEqual(['answer']);
    const p3 = await triage(llm, {
      history: [{ role: 'user', content: 'Fudge cake went up to $58' }],
      meta,
    });
    expect(p3.tasks.map((t) => t.kind)).not.toContain('correct');
  });
});

describe('parseProposal (D2, D4)', () => {
  const wire = (o: object) =>
    JSON.stringify({ ref: '', changes: [], question: '', answer: '', hours: [], ...o });

  it('candidates are F1… without duplicates', () => {
    expect(ctx.candidates.map((c) => [c.ref, c.fact.id])).toEqual([
      ['F1', FUDGE.id],
      ['F2', EGGLESS.id],
      ['F3', PROMO.id],
    ]);
  });

  it('maps an edit to the fact, in cents', () => {
    expect(
      parseProposal(
        wire({ action: 'edit_fact', ref: 'F1', changes: [{ field: 'price', value: '58' }] }),
        ctx,
      ),
    ).toEqual({
      kind: 'edit_fact',
      factId: FUDGE.id,
      patch: { value: { ...FUDGE.value, priceCents: 5800, currency: 'SGD' } },
    });
  });

  it("maps a promotion's last day to its exclusive end", () => {
    const p = parseProposal(
      wire({
        action: 'edit_fact',
        ref: 'F3',
        changes: [{ field: 'valid_until', value: '2026-11-30' }],
      }),
      ctx,
    );
    expect(p).toMatchObject({
      kind: 'edit_fact',
      factId: PROMO.id,
      patch: { validity: { validUntil: new Date('2026-11-30T16:00:00.000Z') } },
    });
  });

  it('maps an FAQ and an hours change', () => {
    expect(
      parseProposal(wire({ action: 'add_faq', question: 'Halal?', answer: 'No.' }), ctx),
    ).toEqual({ kind: 'add_faq', question: 'Halal?', answer: 'No.' });
    expect(
      parseProposal(
        wire({
          action: 'edit_hours',
          hours: [
            { day: 'sat', value: '09:00-17:00' },
            { day: 'sun', value: '09:00-17:00' },
          ],
        }),
        ctx,
      ),
    ).toEqual({
      kind: 'edit_hours',
      profileVersion: 4,
      before: { sat: HOURS.sat, sun: [] },
      after: { sat: [{ open: '09:00', close: '17:00' }], sun: [{ open: '09:00', close: '17:00' }] },
    });
  });

  it('unknown refs, fields of another type, bad values and none give null', () => {
    for (const w of [
      wire({ action: 'edit_fact', ref: 'F9', changes: [{ field: 'price', value: '1' }] }),
      wire({ action: 'edit_fact', ref: 'F2', changes: [{ field: 'price', value: '1' }] }),
      wire({ action: 'edit_fact', ref: 'F1', changes: [{ field: 'price', value: 'cheap' }] }),
      wire({ action: 'edit_hours', hours: [{ day: 'sat', value: '9 to 5' }] }),
      wire({ action: 'none' }),
      'not json',
    ])
      expect(parseProposal(w, ctx)).toBeNull();
  });
});

describe('the fake propose step', () => {
  const run = (ownerText: string) =>
    proposeChange(llm, { ownerText, previousAnswer: null, ctx, meta: { tenantId: 't' } });

  it('turns a $ amount into a price change on the product named', async () => {
    expect(await run('Fudge cake went up to $58')).toMatchObject({
      kind: 'edit_fact',
      factId: FUDGE.id,
      patch: { value: { priceCents: 5800 } },
    });
  });

  it('turns "open … to …" into hours, and Q/A into a new FAQ', async () => {
    expect(await run("We're open 9am to 5pm on weekends now")).toMatchObject({
      kind: 'edit_hours',
      after: { sat: [{ open: '09:00', close: '17:00' }], sun: [{ open: '09:00', close: '17:00' }] },
    });
    expect(await run('Q: Do you deliver to Sentosa? A: Yes, above $80.')).toEqual({
      kind: 'add_faq',
      question: 'Do you deliver to Sentosa?',
      answer: 'Yes, above $80.',
    });
  });

  it('gives null when it cannot tell', async () => {
    expect(await run('That is not right')).toBeNull();
    expect(fakeAgentScript(req(PROPOSE_SYSTEM, 'nothing'))).toContain('"none"');
  });
});

describe('propose_correction (ADR-025 decision 3, AC-10)', () => {
  const call = {
    id: 'tc-1',
    name: 'propose_correction',
    input: { kind: 'add_faq', question: 'Q', answer: 'A' },
  };

  it('stores the proposal through the coaching port when the plan has correct', async () => {
    const { c, audits, proposed } = dispatchCtx('coaching');
    const r = await dispatchToolCall(coachingRegistry, call, plan(['correct']), c);
    expect(r).toMatchObject({
      task: 'correct',
      outcome: 'done',
      result: { proposal: { correctionId: 'corr-1' } },
    });
    expect(proposed).toEqual([{ kind: 'add_faq', question: 'Q', answer: 'A' }]);
    expect(audits).toEqual([{ task: 'correct', tool: 'propose_correction', outcome: 'done' }]);
  });

  it('is refused without a correct task, and in a visitor context', async () => {
    const a = dispatchCtx('coaching');
    expect(await dispatchToolCall(coachingRegistry, call, plan(['answer']), a.c)).toMatchObject({
      outcome: 'refused',
      reason: 'not_in_plan',
    });
    const v = dispatchCtx('visitor');
    expect(await dispatchToolCall(coachingRegistry, call, plan(['correct']), v.c)).toMatchObject({
      outcome: 'refused',
      reason: 'scope',
    });
    expect(await dispatchToolCall(visitorRegistry, call, plan(['correct']), v.c)).toMatchObject({
      outcome: 'refused',
      reason: 'scope',
    });
    expect(a.proposed).toEqual([]);
    expect(v.proposed).toEqual([]);
  });

  it('a visitor plan carrying correct dispatches nothing (unhandled)', async () => {
    const v = dispatchCtx('visitor');
    const r = await dispatchPlan(visitorRegistry, plan(['answer', 'correct']), v.c);
    expect(r.reports).toEqual([{ task: 'correct', index: 1, outcome: 'unhandled' }]);
    expect(v.proposed).toEqual([]);
  });

  it('out of scope gets the live refusal in coaching too (UC-04 2a)', async () => {
    const { c } = dispatchCtx('coaching');
    const r = await dispatchPlan(coachingRegistry, plan(['out_of_scope']), c);
    expect(r.replies).toEqual(['out_of_scope']);
  });
});
