import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskKind } from '@kaki/agent';
import { z } from 'zod';

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
]);
export type Subset = z.infer<typeof Subset>;

/** Deterministic scorers. The LLM judge arrives with FEAT-023 (plan §7). */
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
    ]),
  ),
});
export type Fixture = z.infer<typeof Fixture>;

/** What a case is scored on: the released reply and the facts it used. */
export interface Reply {
  text: string;
  factIds: string[];
}

export interface ScoreContext {
  fixture: Fixture;
  /** The tenant's prices as a visitor sees them, e.g. `S$55.00`. */
  renderedPrices: Set<string>;
}

/** Any money amount, in any currency or spelling; only rendered `S$` prices may match. */
const AMOUNT_RE =
  /(?:S\$|US\$|[$€£¥]|\b(?:sgd|usd|rm|myr)\s*)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:(?:singapore|sing|us)\s+)?(?:dollars?|bucks|cents?|ringgit|元|块)/giu;

export function score(reply: Reply, expectations: Expectation[], ctx: ScoreContext): boolean {
  const own = new Set(ctx.fixture.facts.map((f) => f.id));
  return expectations.every((e) => {
    switch (e.kind) {
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
