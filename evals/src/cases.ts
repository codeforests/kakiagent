import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const Subset = z.enum([
  'groundedness',
  'prices',
  'singlish',
  'chinese',
  'out-of-scope',
  'harmful',
  'red-team',
]);
export type Subset = z.infer<typeof Subset>;

/** Deterministic scorers. The LLM judge arrives with FEAT-023 (plan §7). */
export const Expectation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contains'), text: z.string() }),
  z.object({ kind: z.literal('not-contains'), text: z.string() }),
  z.object({ kind: z.literal('matches'), pattern: z.string() }),
]);
export type Expectation = z.infer<typeof Expectation>;

export const Case = z.object({
  id: z.string(),
  subset: Subset,
  fast: z.boolean().default(false),
  /** A fixture tenant: `bakery` or `second` (plan §4 FEAT-022 test data). */
  tenant: z.enum(['bakery', 'second']).default('bakery'),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
  expect: z.array(Expectation).min(1),
});
export type Case = z.infer<typeof Case>;

export function loadCases(dir: string): Case[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => z.array(Case).parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export function score(text: string, expectations: Expectation[]): boolean {
  return expectations.every((e) => {
    if (e.kind === 'contains') return text.includes(e.text);
    if (e.kind === 'not-contains') return !text.includes(e.text);
    return new RegExp(e.pattern, 'u').test(text);
  });
}
