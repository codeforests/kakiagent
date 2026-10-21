import type { StagedFact } from '@kaki/kb';
import { describe, expect, it } from 'vitest';
import { extractionMetrics, ExtractionPage, scoreExtraction } from './extraction.js';

const page = ExtractionPage.parse({
  id: 'p',
  url: 'https://kakibakery.test/p',
  title: 'P',
  text: 'Fudge cake (1 kg) — S$55.00 (GST incl.)\nQ: Halal?\nA: No pork.',
  expected: [
    { type: 'product', quote: 'Fudge cake (1 kg)', priceCents: 5500, gst: 'inclusive' },
    { type: 'faq', quote: 'Q: Halal?' },
  ],
  forbiddenPricesCents: [100],
});

const product = (cents: number, gst: 'inclusive' | 'unknown' = 'inclusive'): StagedFact => ({
  input: {
    type: 'product',
    value: { name: 'Fudge cake', priceCents: cents, currency: 'SGD', unit: '1 kg' },
    gstTreatment: gst,
  },
  quote: 'Fudge cake (1 kg) — S$55.00 (GST incl.)',
  start: 0,
  end: 39,
  confidence: 0.9,
  dedupeKey: 'product:fudge cake:1 kg',
});

describe('extraction scoring (FEAT-012 AC-6)', () => {
  it('matches by type and overlapping passage, and checks price and GST', () => {
    const ok = scoreExtraction(page, [product(5500)]);
    expect(ok).toMatchObject({
      extracted: 1,
      matched: 1,
      expected: 2,
      priced: 1,
      pricedCorrect: 1,
    });
    expect(ok.problems).toEqual(['missed faq: "Q: Halal?"']);
    const wrongGst = scoreExtraction(page, [product(5500, 'unknown')]);
    expect(wrongGst.pricedCorrect).toBe(0);
    expect(extractionMetrics([wrongGst])['extraction-prices']).toBe(0);
  });

  it('counts a fact of the wrong type as unexpected, and a forbidden price fails prices', () => {
    const faqAsPolicy: StagedFact = {
      ...product(5500),
      input: {
        type: 'policy',
        value: { kind: 'other', title: 'x', details: 'y' },
        gstTreatment: null,
      },
    };
    const m = extractionMetrics([scoreExtraction(page, [faqAsPolicy, product(100)])]);
    expect(m['extraction-precision']).toBe(0.5);
    expect(m['extraction-recall']).toBe(0.5);
    expect(m['extraction-prices']).toBe(0);
  });

  it('refuses an expected quote that is not on the page', () => {
    expect(() =>
      ExtractionPage.parse({ ...page, expected: [{ type: 'faq', quote: 'not there' }] }),
    ).toThrow(/not on the page/);
  });
});
