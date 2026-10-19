/**
 * The eval runner (AGT-14, ADR-022). Usage: `pnpm eval [--fast]`.
 * Runs every case through the llm-gateway (the fake provider until M1.5), scores it
 * deterministically, and exits non-zero if any subset is below its threshold.
 */
import { gatewayFromConfig, route } from '@kaki/llm-gateway';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadCases, score, Subset } from './cases.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fast = process.argv.includes('--fast');
const thresholds = z
  .record(z.string(), z.unknown())
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('$'))))
  .pipe(z.record(Subset, z.number().min(0).max(1)))
  .parse(JSON.parse(readFileSync(`${root}thresholds.json`, 'utf8')));

const provider = z.enum(['fake', 'anthropic-dev']).parse(process.env.LLM_PROVIDER ?? 'fake');
const llm = gatewayFromConfig({ provider, anthropicApiKey: process.env.ANTHROPIC_API_KEY });
const cases = loadCases(`${root}cases`).filter((c) => !fast || c.fast);

const FIXTURE_TENANTS = {
  bakery: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
};
const results = new Map<Subset, { passed: number; total: number }>();
for (const c of cases) {
  // FEAT-022 replaces this direct call with agent.runVisitorTurn on fixture tenants.
  const out = await llm.generate({
    model: route('reply'),
    system: 'You are the shop assistant.',
    messages: c.messages,
    maxTokens: 400,
    meta: { tenantId: FIXTURE_TENANTS[c.tenant] },
  });
  const r = results.get(c.subset) ?? { passed: 0, total: 0 };
  r.total++;
  if (score(out.text, c.expect)) r.passed++;
  else console.log(`FAIL ${c.id}`);
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
