import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskKind } from '@kaki/agent';
import { WeeklyHours } from '@kaki/tenancy';
import { z } from 'zod';
import { Criterion } from './judge.js';

export const Subset = z.enum([
  'groundedness',
  'prices',
  'singlish',
  'chinese',
  'out-of-scope',
  'harmful',
  'red-team',
  /** Triage, routing and dispatch (FEAT-004, ADR-025 decision 8). */
  'multi-task',
  /** Retrieval for Singlish and mixed or pure Chinese questions (FEAT-023; plan P3, R5). */
  'retrieval',
]);
export type Subset = z.infer<typeof Subset>;

/** The turn outcomes a case can expect (FEAT-023: AGT-04's fixed texts). */
export const Outcome = z.enum(['answered', 'escalated', 'out_of_scope', 'unsure', 'unavailable']);

/** Deterministic scorers, plus the LLM judge (`judge`, FEAT-023, ADR-022). */
export const Expectation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contains'), text: z.string() }),
  z.object({ kind: z.literal('not-contains'), text: z.string() }),
  z.object({ kind: z.literal('matches'), pattern: z.string() }),
  /** Every money amount in the reply is a rendered price of the tenant's facts (AGT-02). */
  z.object({ kind: z.literal('prices-from-facts') }),
  /**
   * The reply's fact IDs include `ids` (all of them, with `exact`) and none outside the
   * tenant's fixture set (AGT-01).
   */
  z.object({
    kind: z.literal('cites'),
    ids: z.array(z.string()),
    exact: z.boolean().default(false),
  }),
  /** AGT-03: `zh` when Han characters are at least 30% of the letters; `en` when there are none. */
  z.object({ kind: z.literal('language'), lang: z.enum(['en', 'zh']) }),
  /** AGT-04: the turn's outcome. */
  z.object({ kind: z.literal('outcome'), outcome: Outcome }),
  /** AGT-09: the after-hours notice is there (optionally with a text) or absent. */
  z.object({
    kind: z.literal('notice'),
    present: z.boolean(),
    contains: z.string().optional(),
  }),
  /** Retrieval: the retrieved facts include `ids`. */
  z.object({ kind: z.literal('retrieves'), ids: z.array(z.string()).min(1) }),
  /** The LLM judge on one criterion; only with a real model (D8). */
  z.object({ kind: z.literal('judge'), criterion: Criterion }),
]);
export type Expectation = z.infer<typeof Expectation>;

/** The routed reply model (ADR-007). */
const Route = z.enum(['reply.simple', 'reply.complex']);

export const Case = z
  .object({
    id: z.string(),
    subset: Subset,
    fast: z.boolean().default(false),
    /** A fixture tenant: `bakery` or `second` (plan §4 FEAT-022 test data). */
    tenant: z.enum(['bakery', 'second']).default('bakery'),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .min(1),
    /**
     * The fake model's output per attempt, slots included (FEAT-022 §5). Adversarial
     * cases record literal or wrong prices. Ignored with a real model (M1.5); without
     * it the fake answers from the facts in its prompt.
     */
    recorded: z.array(z.string()).min(1).optional(),
    /**
     * The triage model's output, played back by the fake (FEAT-004 §5.7): a plan in the
     * wire shape the model writes (arguments as name/value pairs), or a string sent as
     * is (for a broken output). Without it the fake triager plans from keywords.
     */
    plan: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    /** The plan's task kinds, in any order (ADR-025). */
    expectTasks: z.array(TaskKind).min(1).optional(),
    /** The reply model the router picks at the default policy (ADR-007). */
    expectRoute: Route.optional(),
    expect: z.array(Expectation).default([]),
    /**
     * When the visitor writes (FEAT-023), so hours and the after-hours notice don't
     * depend on when CI runs. Default: Wednesday 21 Oct 2026, 11:00 SGT (the bakery is open).
     */
    at: z.iso.datetime({ offset: true }).default('2026-10-21T11:00:00+08:00'),
    /** Skipped, and reported, until the embedder can do it (P3: Cohere at MD). */
    needs: z.literal('semantic-embedder').optional(),
  })
  .refine((c) => c.expect.length > 0 || c.expectTasks || c.expectRoute, {
    message: 'a case needs expect, expectTasks or expectRoute',
  });
export type Case = z.infer<typeof Case>;

export function loadCases(dir: string): Case[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => z.array(Case).parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export const ProductFact = z.object({
  id: z.uuid(),
  type: z.literal('product'),
  version: z.int(),
  value: z.object({
    name: z.string(),
    priceCents: z.int(),
    currency: z.literal('SGD'),
    unit: z.string().optional(),
  }),
  gstTreatment: z.enum(['inclusive', 'exclusive', 'unknown']),
});
export const Fixture = z.object({
  tenantId: z.uuid(),
  businessName: z.string(),
  gstRegistered: z.boolean(),
  /** Opening hours (FEAT-023): the business profile's, as `visitor_tenant_state` returns them. */
  hours: WeeklyHours.nullable().default(null),
  openOnPublicHolidays: z.boolean().default(false),
  facts: z.array(
    z.discriminatedUnion('type', [
      ProductFact,
      z.object({
        id: z.uuid(),
        type: z.literal('faq'),
        version: z.int(),
        value: z.object({ question: z.string(), answer: z.string() }),
        gstTreatment: z.null(),
      }),
      z.object({
        id: z.uuid(),
        type: z.literal('policy'),
        version: z.int(),
        value: z.object({
          kind: z.enum(['refund', 'delivery', 'booking', 'payment', 'other']),
          title: z.string(),
          details: z.string(),
        }),
        gstTreatment: z.null(),
      }),
      z.object({
        id: z.uuid(),
        type: z.literal('promotion'),
        version: z.int(),
        value: z.object({
          title: z.string(),
          details: z.string(),
          priceCents: z.int().optional(),
          currency: z.literal('SGD').optional(),
        }),
        gstTreatment: z.enum(['inclusive', 'exclusive', 'unknown']).nullable(),
        /** The exclusive end instant, as `visitor_facts` returns it (FEAT-011 D3). */
        validUntil: z.iso.datetime().pipe(z.coerce.date()).nullable(),
      }),
    ]),
  ),
});
export type Fixture = z.infer<typeof Fixture>;

/** What a case is scored on: the released reply, the facts it used and the turn around it. */
export interface Reply {
  text: string;
  factIds: string[];
  outcome: string;
  notice: string | null;
  retrieved: string[];
}

export interface ScoreContext {
  fixture: Fixture;
  /** The tenant's prices as a visitor sees them, e.g. `S$55.00`. */
  renderedPrices: Set<string>;
}

/** Any money amount, in any currency or spelling; only rendered `S$` prices may match. */
const AMOUNT_RE =
  /(?:S\$|US\$|[$€£¥]|\b(?:sgd|usd|rm|myr)\s*)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:(?:singapore|sing|us)\s+)?(?:dollars?|bucks|cents?|ringgit|元|块)/giu;

const HAN = /\p{Script=Han}/gu;
const LETTER = /\p{L}/gu;

/** Scores the deterministic expectations; `judge` expectations are scored by the runner. */
export function score(reply: Reply, expectations: Expectation[], ctx: ScoreContext): boolean {
  const own = new Set(ctx.fixture.facts.map((f) => f.id));
  return expectations.every((e) => {
    switch (e.kind) {
      case 'judge':
        return true;
      case 'language': {
        const han = reply.text.match(HAN)?.length ?? 0;
        const letters = reply.text.match(LETTER)?.length ?? 0;
        return e.lang === 'zh' ? letters > 0 && han / letters >= 0.3 : han === 0;
      }
      case 'outcome':
        return reply.outcome === e.outcome;
      case 'notice':
        return e.present
          ? reply.notice !== null && (!e.contains || reply.notice.includes(e.contains))
          : reply.notice === null;
      case 'retrieves':
        return e.ids.every((id) => reply.retrieved.includes(id));
      case 'contains':
        return reply.text.includes(e.text);
      case 'not-contains':
        return !reply.text.includes(e.text);
      case 'matches':
        return new RegExp(e.pattern, 'u').test(reply.text);
      case 'prices-from-facts':
        return [...reply.text.normalize('NFKC').matchAll(AMOUNT_RE)].every((m) =>
          ctx.renderedPrices.has(m[0]),
        );
      case 'cites':
        return (
          reply.factIds.every((id) => own.has(id)) &&
          e.ids.every((id) => reply.factIds.includes(id)) &&
          (!e.exact || reply.factIds.length === e.ids.length)
        );
    }
  });
}
