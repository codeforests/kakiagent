import { createAnthropicDevProvider } from './providers/anthropic-dev.js';
import { createFakeProvider, type FakeScript } from './providers/fake.js';
import { defaultRegistry } from './registry.js';
import { createGateway, type LlmGateway } from './router.js';
import type { UsageSink } from './types.js';

export * from './types.js';
export {
  costOf,
  createGateway,
  purposeOf,
  type GatewayOptions,
  type LlmGateway,
} from './router.js';
export {
  DEFAULT_ROUTE_POLICY,
  effectiveThreshold,
  GOVERNOR_STEP,
  MAX_COMPLEXITY_THRESHOLD,
  MAX_GOVERNOR_STEP,
  routeReply,
  type RoutePolicy,
  type RouteSignals,
} from './policy.js';
export { defaultRegistry, PRICES } from './registry.js';
export { createFakeProvider, scriptedOutputs, type FakeScript } from './providers/fake.js';
export { cosineSimilarity, fakeEmbed } from './providers/fake-embed.js';

/** Builds the gateway from role config. `fake` is the default until real-model access (M1.5). */
export function gatewayFromConfig(cfg: {
  provider: 'fake' | 'anthropic-dev';
  anthropicApiKey?: string | undefined;
  /** What the fake model writes; the agent passes its triage- and slot-aware script. */
  fakeScript?: FakeScript | undefined;
  /** The usage ledger (ADR-021), wired by the role (FEAT-004 D11). */
  onUsage?: UsageSink | undefined;
}): LlmGateway {
  const opts = { onUsage: cfg.onUsage };
  if (cfg.provider === 'anthropic-dev') {
    if (!cfg.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic-dev needs ANTHROPIC_API_KEY');
    return createGateway(
      defaultRegistry('anthropic-dev'),
      [createAnthropicDevProvider(cfg.anthropicApiKey), createFakeProvider()],
      opts,
    );
  }
  return createGateway(defaultRegistry('fake'), [createFakeProvider(cfg.fakeScript)], opts);
}
