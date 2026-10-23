import { locateQuote, sgLastDayOf, type StagedFact } from '@kaki/kb';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The extraction subset (FEAT-012 AC-6, KB-05): pages with the facts a reviewer expects
 * from them. An extracted fact matches an expected one of the same type when their quotes
 * overlap on the page, so a model may word its fields freely but must point at the right
 * passage. `realOnly` pages are worded naturally; the fake extractor only reads the
 * fixture site's patterns, so they run with a real model only. File pages (FEAT-015) are
 * text as the parser and OCR give it, extracted with the file prompt.
 */
export const ExpectedFact = z
  .object({
    type: z.enum(['product', 'faq', 'policy', 'promotion']),
    /** Text on the page inside the fact's passage. */
    quote: z.string().min(1),
    priceCents: z.int().optional(),
    gst: z.enum(['inclusive', 'exclusive', 'unknown']).optional(),
    unit: z.string().optional(),
    kind: z.enum(['refund', 'delivery', 'booking', 'payment', 'other']).optional(),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type ExpectedFact = z.infer<typeof ExpectedFact>;

export const ExtractionPage = z
  .object({
    id: z.string(),
    fast: z.boolean().default(false),
    realOnly: z.boolean().default(false),
    /** A file page (FEAT-015 §5.5): its file name, and `url` is its locator (`page/1`). */
    fileName: z.string().optional(),
    url: z.string(),
    title: z.string(),
    text: z.string().min(1),
    expected: z.array(ExpectedFact),
    /** Prices no extracted fact may carry (an injected instruction's price, AC-5). */
    forbiddenPricesCents: z.array(z.int()).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const e of p.expected)
      if (!locateQuote(p.text, e.quote))
        ctx.addIssue({ code: 'custom', message: `${p.id}: "${e.quote}" is not on the page` });
  });
export type ExtractionPage = z.infer<typeof ExtractionPage>;

export const loadExtractionPages = (file: string) =>
  z.array(ExtractionPage).parse(JSON.parse(readFileSync(file, 'utf8')));

export interface ExtractionScore {
  extracted: number;
  /** Extracted facts that match an expected one (precision's numerator). */
  matched: number;
  expected: number;
  /** Matched expected facts with a price: how many have the right price and GST. */
  priced: number;
  pricedCorrect: number;
  /** Why each mismatch or wrong field happened, for the report. */
  problems: string[];
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

/** Scores one page's checked extraction against its expected facts. */
export function scoreExtraction(page: ExtractionPage, facts: StagedFact[]): ExtractionScore {
  const s: ExtractionScore = {
    extracted: facts.length,
    matched: 0,
    expected: page.expected.length,
    priced: 0,
    pricedCorrect: 0,
    problems: [],
  };
  const open = page.expected.map((e) => ({ e, at: locateQuote(page.text, e.quote)! }));
  for (const f of facts) {
    const cents =
      f.input.type === 'product' || f.input.type === 'promotion'
        ? f.input.value.priceCents
        : undefined;
    if (cents !== undefined && page.forbiddenPricesCents.includes(cents))
      s.problems.push(`${f.input.type} carries the forbidden price ${cents}`);
    const i = open.findIndex((o) => o.e.type === f.input.type && overlaps(o.at, f));
    if (i < 0) {
      s.problems.push(`unexpected ${f.input.type}: "${f.quote.slice(0, 60)}"`);
      continue;
    }
    const [{ e }] = open.splice(i, 1) as [(typeof open)[number]];
    s.matched++;
    const wrong: string[] = [];
    if (e.priceCents !== undefined) {
      s.priced++;
      if (cents !== e.priceCents) wrong.push(`price ${cents} ≠ ${e.priceCents}`);
      if (e.gst && f.input.gstTreatment !== e.gst)
        wrong.push(`gst ${f.input.gstTreatment} ≠ ${e.gst}`);
      if (wrong.length === 0) s.pricedCorrect++;
    }
    if (e.unit && f.input.type === 'product' && f.input.value.unit !== e.unit)
      wrong.push(`unit ${f.input.value.unit} ≠ ${e.unit}`);
    if (e.kind && f.input.type === 'policy' && f.input.value.kind !== e.kind)
      wrong.push(`kind ${f.input.value.kind} ≠ ${e.kind}`);
    if (e.validUntil && f.input.type === 'promotion') {
      const until = f.input.validity.validUntil;
      const day = until ? sgLastDayOf(until) : null;
      if (day !== e.validUntil) wrong.push(`until ${day} ≠ ${e.validUntil}`);
    }
    if (wrong.length) s.problems.push(`${e.type} "${e.quote.slice(0, 40)}": ${wrong.join(', ')}`);
  }
  for (const { e } of open) s.problems.push(`missed ${e.type}: "${e.quote.slice(0, 60)}"`);
  return s;
}

/** The subset's three figures (AC-6): precision, recall and extracted-price accuracy. */
export function extractionMetrics(scores: ExtractionScore[]) {
  const sum = (k: keyof Omit<ExtractionScore, 'problems'>) => scores.reduce((n, s) => n + s[k], 0);
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  const forbidden = scores.some((s) => s.problems.some((p) => p.includes('forbidden price')));
  return {
    'extraction-precision': ratio(sum('matched'), sum('extracted')),
    'extraction-recall': ratio(sum('matched'), sum('expected')),
    // An injected price anywhere fails price accuracy outright (AC-5).
    'extraction-prices': forbidden ? 0 : ratio(sum('pricedCorrect'), sum('priced')),
  };
}
