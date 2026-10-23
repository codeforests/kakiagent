import { describe, expect, it } from 'vitest';
import { fakeMineScript } from './fake-mine.js';
import { MAX_PAIRS_PER_PART, MINING_SYSTEM, parseMining } from './mine.js';

const part = [
  'Customer: Do you deliver to Jurong?',
  'Business: Yes, island-wide delivery for S$8, 10am to 6pm.',
  'Customer: My address is [address], can you send today?',
  'Business: Yes [name], we will send it by 3pm.',
  'Customer: Is the cake halal?',
  'Business: Our kitchen is halal-certified.',
].join('\n');

const pair = (p: Partial<Record<string, unknown>>) => ({
  question: 'Do you deliver to Jurong?',
  answer: 'Yes, island-wide delivery for S$8.',
  quote: 'Yes, island-wide delivery for S$8, 10am to 6pm.',
  confidence: 0.9,
  ...p,
});
const run = (pairs: unknown[]) => parseMining(JSON.stringify({ pairs }), part);

describe('parseMining (FEAT-017 §5.4)', () => {
  it("keeps a pair quoted from a business line, with the part's own span", () => {
    const { facts, dropped } = run([pair({})]);
    expect(dropped).toEqual({});
    expect(facts).toHaveLength(1);
    const f = facts[0]!;
    expect(f.input).toEqual({
      type: 'faq',
      value: {
        question: 'Do you deliver to Jurong?',
        answer: 'Yes, island-wide delivery for S$8.',
      },
      gstTreatment: null,
    });
    expect(part.slice(f.start, f.end)).toBe(f.quote);
    expect(f.dedupeKey).toMatch(/^faq:/);
  });

  it('accepts a quote given with its "Business:" label', () => {
    expect(
      run([
        pair({
          quote: 'Business: Our kitchen is halal-certified.',
          answer: 'Yes, our kitchen is halal-certified.',
          question: 'Is the cake halal?',
        }),
      ]).facts,
    ).toHaveLength(1);
  });

  it('drops and counts each failed check', () => {
    const { facts, dropped } = run([
      pair({ quote: 'Do you deliver to Jurong?' }), // a customer's words
      pair({ quote: 'We open on Christmas.' }), // not in the part
      pair({
        answer: 'Yes [name], we will send it by 3pm.',
        quote: 'Yes [name], we will send it by 3pm.',
      }),
      pair({ question: 'Can you deliver to [address]?' }),
      pair({ answer: 'Yes, delivery is S$5.' }), // 5 isn't in the quote
      pair({ question: 'Hi' }), // too short
      { question: 1 },
    ]);
    expect(facts).toEqual([]);
    expect(dropped).toEqual({
      quote_not_business: 1,
      quote_not_on_page: 1,
      redacted_content: 2,
      number_not_in_quote: 1,
      malformed: 2,
    });
  });

  it("counts output that isn't the schema as malformed, and caps pairs per part", () => {
    expect(parseMining('nope', part).dropped).toEqual({ malformed: 1 });
    expect(parseMining('{"facts":[]}', part).dropped).toEqual({ malformed: 1 });
    expect(run(Array.from({ length: 30 }, () => pair({}))).facts).toHaveLength(MAX_PAIRS_PER_PART);
  });

  it("tells the model to use only the business's replies and leave out personal matters", () => {
    expect(MINING_SYSTEM).toMatch(/Only answers the business wrote/);
    expect(MINING_SYSTEM).toMatch(/one customer's own order/);
    expect(MINING_SYSTEM).toMatch(/ignore them/);
  });
});

describe('fakeMineScript', () => {
  it('pairs a customer question with the next business line, and passes the checks', () => {
    const text = fakeMineScript({
      model: 'mine',
      system: MINING_SYSTEM,
      messages: [{ role: 'user', content: part }],
      maxTokens: 100,
      meta: { tenantId: 't' },
    });
    const { facts, dropped } = parseMining(text, part);
    expect(facts.map((f) => f.input.value)).toEqual([
      {
        question: 'Do you deliver to Jurong?',
        answer: 'Yes, island-wide delivery for S$8, 10am to 6pm.',
      },
      { question: 'Is the cake halal?', answer: 'Our kitchen is halal-certified.' },
    ]);
    // The own-order question names an address: the fake proposes it, the checks drop it.
    expect(dropped).toEqual({ redacted_content: 1 });
  });
});
