/**
 * The eval runner (AGT-14, ADR-022). Usage: `pnpm eval [--fast]`.
 * Runs every case through the agent's own triage, routing, dispatch and reply decision
 * (`triage`, `routeReply`, `dispatchPlan`, `answerTurn`: the code the worker runs) on a
 * fixture tenant, with in-memory retrieval over its facts and the fixture's opening
 * hours at the case's `at` (FEAT-023), scores the plan, the route and the released reply
 * deterministically, reports the cost per conversation, and exits non-zero if any
 * subset is below its threshold. Every case runs with the tenant's assistant settings
 * (FEAT-024), the defaults unless its fixture or the case sets them, as the worker does. The fake provider plays each case's recorded output
 * until M1.5; with `LLM_PROVIDER=anthropic-dev` the real model answers instead, and the
 * LLM judge scores the `judge` expectations and its agreement sample (FEAT-023 D8).
 */
import {
  answerTurn,
  buildVisitorPrompt,
  dispatchPlan,
  fakeTriage,
  fakeVisitorResponder,
  hoursLines,
  leakGuard,
  renderPrice,
  assignRefs,
  replyLanguage,
  routeSignals,
  safetyText,
  systemSlots,
  textsFor,
  triage,
  TRIAGE_SYSTEM,
  visitorRegistry,
  type ConversationPort,
  type DispatchContext,
  type HoursContext,
  type ReplyKey,
  type SafetyKey,
  type TaskKind,
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
import { DEFAULT_PERSONA, openStatus, type Persona } from '@kaki/tenancy';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  Fixture,
  loadCases,
  score,
  Subset,
  type Case,
  type Reply,
  type ScoreContext,
} from './cases.js';
import { agreement, AgreementSample, checkSample, isDraft, judge, MIN_AGREEMENT } from './judge.js';

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
const allCases = loadCases(`${root}cases`);
const cases = allCases.filter((c) => !fast || c.fast);
const evalSetVersion = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(`${root}version.json`, 'utf8'))).version;
const sample = AgreementSample.parse(
  JSON.parse(readFileSync(`${root}labels/agreement-sample.json`, 'utf8')),
);

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
    // FEAT-025 `no-leak`: the rules of this tenant's reply prompt and of triage.
    const sample = buildVisitorPrompt({
      businessName: fixture.businessName,
      gstRegistered: fixture.gstRegistered,
      facts: assignRefs(fixture.facts),
      ordered: fixture.facts,
      history: [{ role: 'user', content: '?' }],
      now: new Date('2026-10-21T03:00:00Z'),
      meta: { tenantId: fixture.tenantId },
      model: 'reply.simple',
      language: 'en',
      register: 'standard',
      injection: true,
      impersonation: true,
      outOfScope: true,
    });
    const leak = leakGuard({ system: `${TRIAGE_SYSTEM}\n${sample.system}`, tail: sample.tail });
    return [name, { fixture, chunks, renderedPrices, leak }];
  }),
) as Record<
  Case['tenant'],
  {
    fixture: Fixture & { facts: VisitorFact[] };
    chunks: { fact: VisitorFact; vector: number[] }[];
    renderedPrices: Set<string>;
    leak: ScoreContext['leak'];
    ctx: ScoreContext;
  }
>;
// What only the other fixture tenant has: its name, its texts and its own prices (GOV-03).
for (const [name, f] of Object.entries(fixtures)) {
  const other = Object.entries(fixtures).find(([n]) => n !== name)![1];
  const foreign = [
    other.fixture.businessName,
    ...other.fixture.facts.flatMap((x) =>
      x.type === 'faq'
        ? [x.value.answer]
        : x.type === 'policy'
          ? [x.value.details]
          : x.type === 'promotion'
            ? [x.value.title]
            : [],
    ),
    ...[...other.renderedPrices].filter((p) => !f.renderedPrices.has(p)),
  ];
  f.ctx = { fixture: f.fixture, renderedPrices: f.renderedPrices, leak: f.leak, foreign };
}

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

/** The persona the worker reads from `visitor_tenant_state()`: defaults, the fixture's, the case's. */
function personaOf(c: Case): Persona {
  const { version: _v, updatedAt: _u, ...defaults } = DEFAULT_PERSONA;
  return { ...defaults, ...fixtures[c.tenant].fixture.persona, ...c.persona };
}

/** The fake model for a case: its recorded plan for triage, its recorded reply otherwise. */
function fakeScript(c: Case): FakeScript {
  const reply: FakeScript = c.replyFails
    ? () => {
        throw new Error('provider unavailable (eval case)');
      }
    : c.recorded
      ? scriptedOutputs(c.recorded)
      : fakeVisitorResponder;
  const plan = c.plan;
  const triageOutput: FakeScript =
    plan === undefined
      ? fakeTriage
      : () => (typeof plan === 'string' ? plan : JSON.stringify(plan));
  return (req) => (req.model === 'triage' ? triageOutput(req) : reply(req));
}

/**
 * ADR-025's dispatch check: every planned task other than `answer` is reported and
 * audited, in phase order, none dropped: `done` for kinds with a visitor handler
 * (FEAT-023: `out_of_scope`), `unhandled` for the rest.
 */
async function dispatchCheck(
  plan: TurnPlan,
  tenantId: string,
  conversation: ConversationPort,
): Promise<{ error: string | null; replies: ReplyKey[]; endTurn: SafetyKey | null }> {
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
    conversation,
  };
  const { reports, replies, endTurn } = await dispatchPlan(visitorRegistry, plan, ctx);
  const planned = plan.tasks.filter((t) => t.kind !== 'answer').map((t) => t.kind);
  const reported = reports.map((r) => `${r.task}:${r.outcome}`);
  const expected = (kind: TaskKind) =>
    kind !== 'answer' && visitorRegistry.byKind.has(kind) ? 'done' : 'unhandled';
  // A safety task ends the dispatch (ADR-025 decision 6): the rest are never run.
  const ok =
    (endTurn !== undefined || reports.length === planned.length) &&
    reports.every((r) => r.outcome === expected(r.task)) &&
    (endTurn !== undefined ||
      [...planned].sort().join() ===
        reports
          .map((r) => r.task)
          .sort()
          .join()) &&
    audited.join() === reported.join();
  return {
    error: ok ? null : `dispatch ${JSON.stringify(reported)} for ${JSON.stringify(planned)}`,
    replies,
    endTurn: endTurn?.key ?? null,
  };
}

/**
 * The conversation port in memory (FEAT-025 §5.7): each case is one conversation, with
 * `priorAbuse` earlier abuse turns.
 */
function memoryConversation(priorAbuse: number) {
  const state = {
    flags: [] as string[],
    abuseTurns: new Set(Array.from({ length: priorAbuse }, (_, i) => `earlier-${i}`)),
    aiEnded: false,
  };
  const port: ConversationPort = {
    async flag(reason) {
      if (!state.flags.includes(reason)) state.flags.push(reason);
    },
    async recordAbuse(turnId) {
      state.abuseTurns.add(turnId);
      return state.abuseTurns.size;
    },
    async endAi() {
      state.aiEnded = true;
    },
  };
  return { state, port };
}

/** The fixture's hours at the case's instant, as the worker computes them (FEAT-023 §5.7). */
function hoursAt(fixture: Fixture, at: Date): HoursContext | null {
  if (!fixture.hours) return null;
  return {
    hours: fixture.hours,
    openOnPublicHolidays: fixture.openOnPublicHolidays,
    status: openStatus(fixture.hours, fixture.openOnPublicHolidays, at),
    now: at,
  };
}

async function runCase(c: Case) {
  const { fixture } = fixtures[c.tenant];
  const llm: LlmGateway =
    realModel ?? gatewayFromConfig({ provider: 'fake', fakeScript: fakeScript(c), onUsage });
  const meta = { tenantId: fixture.tenantId };
  const query = c.messages.filter((m) => m.role === 'user').at(-1)!.content;
  const at = new Date(c.at);
  const plan = await triage(llm, { history: c.messages, meta });
  const conversation = memoryConversation(c.priorAbuse);
  const dispatch = await dispatchCheck(plan, fixture.tenantId, conversation.port);
  const route = routeReply(routeSignals(plan, false), DEFAULT_ROUTE_POLICY);
  const language = replyLanguage(plan, query);
  const hours = hoursAt(fixture, at);
  const slots = systemSlots(hours, language);
  const facts = retrieve(c.tenant, query);
  const persona = personaOf(c);
  const texts = textsFor(language, persona);
  const turnState = {
    safety: dispatch.endTurn,
    flags: conversation.state.flags,
    aiEnded: conversation.state.aiEnded,
  };
  // A safety task ended the turn: its fixed text is the reply, as the worker stores it.
  if (dispatch.endTurn) {
    const reply: Reply = {
      text: safetyText(texts, dispatch.endTurn, fixture.businessName),
      factIds: [],
      outcome: 'ended',
      notice: dispatch.endTurn === 'abuse_ended' ? texts.chatEnded : null,
      disclosure: texts.disclosure(fixture.businessName),
      retrieved: facts.map((f) => f.id),
      ...turnState,
    };
    return { reply, plan, route: null, dispatchError: dispatch.error, facts, hours, llm, persona };
  }
  const result = await answerTurn(
    {
      facts,
      history: c.messages,
      businessName: fixture.businessName,
      gstRegistered: fixture.gstRegistered,
      meta,
      model: route,
      now: at,
      language,
      register: plan.register,
      hours,
      systemSlots: slots,
      plan,
      replies: dispatch.replies,
      minConfidence: DEFAULT_ROUTE_POLICY.minConfidence,
      persona,
    },
    { llm, gateOpen: async () => true, publish: async () => {} },
  );
  // Each case is one conversation, so the notice is due whenever the business is closed.
  const notice =
    hours && !hours.status.open ? texts.afterHours(slots.get('next_open') ?? null) : null;
  // A failed reply closes with the fallback text, after anything already verified (turn.ts).
  const text =
    result.outcome === 'unavailable'
      ? result.text
        ? `${result.text} ${texts.fallback}`
        : texts.fallback
      : result.text;
  const reply: Reply = {
    text,
    factIds: result.factIds,
    outcome: result.outcome,
    notice,
    disclosure: texts.disclosure(fixture.businessName),
    retrieved: facts.map((f) => f.id),
    ...turnState,
  };
  return { reply, plan, route, dispatchError: dispatch.error, facts, hours, llm, persona };
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
    return `${JSON.stringify(run.reply.text)} (${run.reply.outcome}${run.reply.notice ? ', notice' : ''})`;
  return null;
}

/** What the reply model was given, for the judge: the retrieved facts and the hours. */
function judgeFacts(run: Awaited<ReturnType<typeof runCase>>): string[] {
  return [
    ...run.facts.map((f) => `${f.type}: ${JSON.stringify(f.value)}`),
    ...(run.hours ? hoursLines(run.hours.hours, run.hours.openOnPublicHolidays) : []),
  ];
}

/** The judge expectations of a case: null when they pass, else why (real model only). */
async function judged(c: Case, run: Awaited<ReturnType<typeof runCase>>): Promise<string | null> {
  for (const e of c.expect) {
    if (e.kind !== 'judge') continue;
    const v = await judge(run.llm, {
      criterion: e.criterion,
      messages: c.messages,
      reply: run.reply.text,
      facts: judgeFacts(run),
      tone: e.criterion === 'tone' ? run.persona.tone : undefined,
    });
    if (!v.pass) return `judge ${e.criterion}: ${v.reason}`;
  }
  return null;
}

const results = new Map<Subset, { passed: number; total: number }>();
let totalCostUsd = 0;
let skipped = 0;
let pendingJudge = 0;
for (const c of cases) {
  // P3: pure-Chinese retrieval needs Cohere's multilingual embedder (MD), not the fake.
  if (c.needs === 'semantic-embedder' && !realModel) {
    skipped++;
    continue;
  }
  caseCostUsd = 0;
  const run = await runCase(c);
  const judges = c.expect.filter((e) => e.kind === 'judge').length;
  let why = failure(c, run);
  if (why === null && judges) {
    if (realModel) why = await judged(c, run);
    else pendingJudge += judges;
  }
  totalCostUsd += caseCostUsd;
  const r = results.get(c.subset) ?? { passed: 0, total: 0 };
  r.total++;
  if (why === null) r.passed++;
  else console.log(`FAIL ${c.id}: ${why}`);
  results.set(c.subset, r);
}

let failed = false;
console.log(
  `eval set ${evalSetVersion}: ${cases.length} case(s)${fast ? ' (fast subset)' : ''}, provider ${provider}`,
);
if (skipped)
  console.log(`  ${skipped} case(s) skipped: they need the semantic embedder (P3, counted at MD)`);
if (pendingJudge)
  console.log(`  ${pendingJudge} judge expectation(s) pending the real judge (M1.5, D8)`);
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

// ADR-022 agreement: the sample's static checks fail every run; the judge's agreement
// with the human labels is measured only with a real model, and never on draft labels.
const judgeExpectations = allCases.reduce(
  (n, c) => n + c.expect.filter((e) => e.kind === 'judge').length,
  0,
);
const sampleError = checkSample(sample, evalSetVersion, judgeExpectations);
if (sampleError) {
  failed = true;
  console.log(`  agreement: ${sampleError}`);
} else if (!realModel) {
  console.log(
    `  agreement: ${sample.items.length} labelled item(s) for ${judgeExpectations} judge expectation(s); measured with the real judge`,
  );
} else if (isDraft(sample)) {
  failed = true;
  console.log(
    `  agreement: the sample is labelled "${sample.labelledBy}"; a person must confirm every label before the real judge is checked against it`,
  );
} else if (realModel) {
  const verdicts = [];
  for (const item of sample.items) verdicts.push(await judge(realModel, item));
  const rate = agreement(sample, verdicts);
  const ok = rate >= MIN_AGREEMENT;
  if (!ok) failed = true;
  console.log(
    `  agreement: ${rate.toFixed(3)} on ${sample.items.length} item(s) (minimum ${MIN_AGREEMENT}) ${ok ? 'ok' : 'BELOW'}`,
  );
}
process.exit(failed ? 1 : 0);
