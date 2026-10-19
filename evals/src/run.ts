/**
 * The eval runner (AGT-14, ADR-022). Usage: `pnpm eval [--fast]`.
 * Runs every case through the agent's verified-reply pipeline (`composeReply`, the
 * same code the worker runs) on a fixture tenant, with in-memory retrieval over its
 * facts, scores the released reply deterministically, and exits non-zero if any
 * subset is below its threshold. The fake provider plays each case's recorded output
 * until M1.5; with `LLM_PROVIDER=anthropic-dev` the real model answers instead.
 */
import { composeReply, fakeVisitorResponder, renderPrice } from '@kaki/agent';
import { chunkContent, DEFAULT_SEARCH, type VisitorFact } from '@kaki/kb';
import {
  cosineSimilarity,
  fakeEmbed,
  gatewayFromConfig,
  scriptedOutputs,
  type LlmGateway,
} from '@kaki/llm-gateway';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Fixture, loadCases, score, Subset, type Case, type ScoreContext } from './cases.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fast = process.argv.includes('--fast');
const thresholds = z
  .record(z.string(), z.unknown())
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('$'))))
  .pipe(z.record(Subset, z.number().min(0).max(1)))
  .parse(JSON.parse(readFileSync(`${root}thresholds.json`, 'utf8')));

const provider = z.enum(['fake', 'anthropic-dev']).parse(process.env.LLM_PROVIDER ?? 'fake');
const realModel =
  provider === 'anthropic-dev'
    ? gatewayFromConfig({ provider, anthropicApiKey: process.env.ANTHROPIC_API_KEY })
    : null;
const cases = loadCases(`${root}cases`).filter((c) => !fast || c.fast);

const fixtures = Object.fromEntries(
  (['bakery', 'second'] as const).map((name) => {
    const fixture = Fixture.parse(
      JSON.parse(readFileSync(`${root}fixtures/${name}.json`, 'utf8')),
    ) as Fixture & { facts: VisitorFact[] };
    const chunks = fixture.facts.map((f) => ({ fact: f, vector: fakeEmbed(chunkContent(f)) }));
    const renderedPrices = new Set(
      fixture.facts.flatMap((f) =>
        // Only the price a visitor may see: GST-inclusive for a registered tenant (KB-15).
        f.type === 'product' ? [renderPrice(f, fixture.gstRegistered).split(' ')[0]!] : [],
      ),
    );
    return [name, { fixture, chunks, ctx: { fixture, renderedPrices } satisfies ScoreContext }];
  }),
) as Record<
  Case['tenant'],
  {
    fixture: Fixture & { facts: VisitorFact[] };
    chunks: { fact: VisitorFact; vector: number[] }[];
    ctx: ScoreContext;
  }
>;

/** `lookup_kb` in memory: the same embedder, distance and limits as `visitor_chunks` (D1). */
function retrieve(tenant: Case['tenant'], query: string): VisitorFact[] {
  const q = fakeEmbed(query);
  return fixtures[tenant].chunks
    .map((c) => ({ fact: c.fact, distance: 1 - cosineSimilarity(q, c.vector) }))
    .filter((c) => c.distance <= DEFAULT_SEARCH.maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, DEFAULT_SEARCH.k)
    .map((c) => c.fact);
}

async function runCase(c: Case) {
  const { fixture } = fixtures[c.tenant];
  const llm: LlmGateway =
    realModel ??
    gatewayFromConfig({
      provider: 'fake',
      fakeScript: c.recorded ? scriptedOutputs(c.recorded) : fakeVisitorResponder,
    });
  const query = c.messages.filter((m) => m.role === 'user').at(-1)!.content;
  return composeReply(
    {
      facts: retrieve(c.tenant, query),
      history: c.messages,
      businessName: fixture.businessName,
      gstRegistered: fixture.gstRegistered,
      meta: { tenantId: fixture.tenantId },
    },
    { llm, gateOpen: async () => true, publish: async () => {} },
  );
}

const results = new Map<Subset, { passed: number; total: number }>();
for (const c of cases) {
  const reply = await runCase(c);
  const r = results.get(c.subset) ?? { passed: 0, total: 0 };
  r.total++;
  if (score(reply, c.expect, fixtures[c.tenant].ctx)) r.passed++;
  else console.log(`FAIL ${c.id}: ${JSON.stringify(reply.text)} (${reply.outcome})`);
  results.set(c.subset, r);
}

let failed = false;
console.log(`eval: ${cases.length} case(s)${fast ? ' (fast subset)' : ''}, provider ${provider}`);
for (const subset of Subset.options) {
  const r = results.get(subset);
  const min = thresholds[subset];
  if (!r) {
    console.log(`  ${subset.padEnd(13)} no cases yet (threshold ${min})`);
    continue;
  }
  const rate = r.passed / r.total;
  const ok = min === undefined || rate >= min;
  if (!ok) failed = true;
  console.log(
    `  ${subset.padEnd(13)} ${r.passed}/${r.total} = ${rate.toFixed(3)} (threshold ${min}) ${ok ? 'ok' : 'BELOW'}`,
  );
}
process.exit(failed ? 1 : 0);
