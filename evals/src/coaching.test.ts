import { fakeAgentScript } from '@kaki/agent';
import type { VisitorFact } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Fixture } from './cases.js';
import {
  CoachingCase,
  loadCoachingCases,
  MIN_COACHING_CASES,
  runCoachingCase,
  scoreCoaching,
} from './coaching.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = Fixture.parse(
  JSON.parse(readFileSync(`${root}fixtures/bakery.json`, 'utf8')),
) as Fixture & { facts: VisitorFact[] };
const cases = loadCoachingCases(`${root}coaching/cases.json`);
const llm = gatewayFromConfig({ provider: 'fake', fakeScript: fakeAgentScript });
const run = (c: CoachingCase) => runCoachingCase(llm, fixture, c);

describe('the coaching eval set (FEAT-027 §5.6, AC-14)', () => {
  it('has the designed coverage', () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_COACHING_CASES);
    const ids = cases.map((c) => c.id).join(' ');
    for (const topic of ['price', 'faq', 'policy', 'promotion', 'hours', 'add-faq', 'ambiguous'])
      expect(ids).toContain(topic);
    expect(cases.some((c) => !c.expected.correct)).toBe(true);
    expect(cases.some((c) => c.id.startsWith('chinese'))).toBe(true);
    expect(cases.some((c) => c.id.startsWith('singlish'))).toBe(true);
  });

  it.each(cases.filter((c) => !c.realOnly).map((c) => [c.id, c] as const))(
    '%s passes on the fake provider',
    async (_id, c) => {
      expect(scoreCoaching(c, fixture.facts, await run(c))).toEqual([]);
    },
  );
});

describe('coaching scoring', () => {
  const price = cases.find((c) => c.id === 'price-up')!;

  it('fails the wrong fact, the wrong field and the wrong price', async () => {
    const r = await run(price);
    expect(r.proposal?.kind).toBe('edit_fact');
    const otherFact = CoachingCase.parse({
      ...price,
      expected: { ...price.expected, fact: 'b1000005-0000-4000-8000-000000000005' },
    });
    expect(scoreCoaching(otherFact, fixture.facts, r)[0]).toMatch(/^edited fact/);
    const otherField = CoachingCase.parse({
      ...price,
      expected: { ...price.expected, field: 'unit', priceCents: undefined },
    });
    expect(scoreCoaching(otherField, fixture.facts, r)).toEqual(['changed price; expected unit']);
    const otherPrice = CoachingCase.parse({
      ...price,
      expected: { ...price.expected, priceCents: 6000 },
    });
    expect(scoreCoaching(otherPrice, fixture.facts, r)).toEqual(['price 5800; expected 6000']);
  });

  it('fails a question taken for a correction, and a missed correction', async () => {
    const asQuestion = CoachingCase.parse({ ...price, expected: { correct: false } });
    expect(scoreCoaching(asQuestion, fixture.facts, await run(price))).toEqual([
      'a question was triaged as a correction',
    ]);
    const question = cases.find((c) => c.id === 'question-price')!;
    const missed = CoachingCase.parse({ ...question, expected: price.expected });
    expect(scoreCoaching(missed, fixture.facts, await run(question))).toEqual([
      'the correction was not detected',
    ]);
  });
});
