/**
 * The eval runner (AGT-14, ADR-022). Usage: `pnpm eval [--fast]`.
 * Runs every case through the agent's own triage, routing, dispatch and verified-reply
 * pipeline (`triage`, `routeReply`, `dispatchPlan`, `composeReply`: the code the worker
 * runs) on a fixture tenant, with in-memory retrieval over its facts, scores the plan,
 * the route and the released reply deterministically, reports the cost per
 * conversation, and exits non-zero if any subset is below its threshold. The fake
 * provider plays each case's recorded output until M1.5; with
 * `LLM_PROVIDER=anthropic-dev` the real model answers instead.
 */
import {
  composeReply,
  dispatchPlan,
  fakeTriage,
  fakeVisitorResponder,
  renderPrice,
  routeSignals,
  triage,
  visitorRegistry,
  type DispatchContext,
  type TurnPlan,
} from '@kaki/agent';
import { chunkContent, DEFAULT_SEARCH, type VisitorFact } from '@kaki/kb';
import {
  cosineSimilarity,
  DEFAULT_ROUTE_POLICY,
  fakeEmbed,
  gatewayFromConfig,
  routeReply,
  scriptedOutputs,
  type FakeScript,
  type LlmGateway,
  type UsageEvent,
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

/** The cost of the case being run (ADR-021): every model call reports to this sink. */
let caseCostUsd = 0;
const onUsage = async (e: UsageEvent) => void (caseCostUsd += e.costUsd);

const provider = z.enum(['fake', 'anthropic-dev']).parse(process.env.LLM_PROVIDER ?? 'fake');
const realModel =
  provider === 'anthropic-dev'
    ? gatewayFromConfig({ provider, anthropicApiKey: process.env.ANTHROPIC_API_KEY, onUsage })
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
        f.type === 'product' || (f.type === 'promotion' && f.value.priceCents !== undefined)
          ? [
              renderPrice(
                { value: { priceCents: f.value.priceCents! }, gstTreatment: f.gstTreatment },
                fixture.gstRegistered,
              ).split(' ')[0]!,
            ]
          : [],
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

/** The fake model for a case: its recorded plan for triage, its recorded reply otherwise. */
function fakeScript(c: Case): FakeScript {
  const reply = c.recorded ? scriptedOutputs(c.recorded) : fakeVisitorResponder;
  const plan = c.plan;
  const triageOutput: FakeScript =
    plan === undefined
      ? fakeTriage
      : () => (typeof plan === 'string' ? plan : JSON.stringify(plan));
  return (req) => (req.model === 'triage' ? triageOutput(req) : reply(req));
}

/**
 * ADR-025's dispatch check: with the empty visitor registry, every planned task other
 * than `answer` is reported and audited as `unhandled`, in phase order, none dropped.
 */
async function dispatchCheck(plan: TurnPlan, tenantId: string): Promise<string | null> {
  const audited: string[] = [];
  const ctx: DispatchContext = {
    scope: 'visitor',
    tenantId,
    conversationId: 'eval',
    turnId: 'eval',
    gateOpen: async () => true,
    consentGiven: async () => false,
    boundaryRules: async () => null,
    audit: async (e) => void audited.push(`${e.task}:${e.outcome}`),
  };
  const { reports } = await dispatchPlan(visitorRegistry, plan, ctx);
  const planned = plan.tasks.filter((t) => t.kind !== 'answer').map((t) => t.kind);
  const reported = reports.map((r) => `${r.task}:${r.outcome}`);
  const ok =
    reports.length === planned.length &&
    reports.every((r) => r.outcome === 'unhandled') &&
    [...planned].sort().join() ===
      reports
        .map((r) => r.task)
        .sort()
        .join() &&
    audited.join() === reported.join();
  return ok ? null : `dispatch ${JSON.stringify(reported)} for ${JSON.stringify(planned)}`;
}

async function runCase(c: Case) {
  const { fixture } = fixtures[c.tenant];
  const llm: LlmGateway =
    realModel ?? gatewayFromConfig({ provider: 'fake', fakeScript: fakeScript(c), onUsage });
  const meta = { tenantId: fixture.tenantId };
  const query = c.messages.filter((m) => m.role === 'user').at(-1)!.content;
  const plan = await triage(llm, { history: c.messages, meta });
  const dispatchError = await dispatchCheck(plan, fixture.tenantId);
  const route = routeReply(routeSignals(plan, false), DEFAULT_ROUTE_POLICY);
  const reply = await composeReply(
    {
      facts: retrieve(c.tenant, query),
      history: c.messages,
      businessName: fixture.businessName,
      gstRegistered: fixture.gstRegistered,
      meta,
      model: route,
    },
    { llm, gateOpen: async () => true, publish: async () => {} },
  );
  return { reply, plan, route, dispatchError };
}

/** Why a case failed, or null: the plan's kinds, the route, the dispatch check, the reply. */
function failure(c: Case, run: Awaited<ReturnType<typeof runCase>>): string | null {
  const kinds = [...new Set(run.plan.tasks.map((t) => t.kind))].sort();
  if (c.expectTasks && kinds.join() !== [...new Set(c.expectTasks)].sort().join())
    return `tasks ${JSON.stringify(kinds)}, expected ${JSON.stringify(c.expectTasks)}`;
  if (c.expectRoute && run.route !== c.expectRoute)
    return `route ${run.route}, expected ${c.expectRoute}`;
  if (run.dispatchError) return run.dispatchError;
  if (!score(run.reply, c.expect, fixtures[c.tenant].ctx))
    return `${JSON.stringify(run.reply.text)} (${run.reply.outcome})`;
  return null;
}

const results = new Map<Subset, { passed: number; total: number }>();
let totalCostUsd = 0;
for (const c of cases) {
  caseCostUsd = 0;
  const run = await runCase(c);
  totalCostUsd += caseCostUsd;
  const r = results.get(c.subset) ?? { passed: 0, total: 0 };
  r.total++;
  const why = failure(c, run);
  if (why === null) r.passed++;
  else console.log(`FAIL ${c.id}: ${why}`);
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
// NFR-13 / ADR-007 decision 3: each case is one conversation. The fake prices its
// models as their Claude counterparts, so the figure is indicative until M1.5.
const USD_SGD = 1.35;
const avgSgd = cases.length ? (totalCostUsd * USD_SGD) / cases.length : 0;
console.log(
  `  cost: ${cases.length} conversations, US$${totalCostUsd.toFixed(6)}, S$${avgSgd.toFixed(5)} per conversation (target <= S$0.03)`,
);
process.exit(failed ? 1 : 0);
