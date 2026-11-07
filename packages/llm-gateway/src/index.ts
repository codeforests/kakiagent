import type { LlmEnv } from '@kaki/platform/config';
import { createAnthropicDevProvider } from './providers/anthropic-dev.js';
import { createFakeProvider, type FakeScript } from './providers/fake.js';
import { createOpenAiCompatProvider, type JsonMode } from './providers/openai-compat.js';
import {
  defaultRegistry,
  openAiCompatRegistry,
  type TierModels,
  type TierPrices,
} from './registry.js';
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
export {
  defaultRegistry,
  openAiCompatRegistry,
  PRICES,
  type TierModels,
  type TierPrices,
} from './registry.js';
export { createFakeProvider, scriptedOutputs, type FakeScript } from './providers/fake.js';
export {
  createOpenAiCompatProvider,
  type JsonMode,
  type OpenAiCompatOptions,
} from './providers/openai-compat.js';
export { cosineSimilarity, fakeEmbed } from './providers/fake-embed.js';

/** An OpenAI-compatible endpoint and its models (`LLM_PROVIDER=openai-compat`). */
export interface OpenAiCompatConfig {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  models?: Partial<TierModels> | undefined;
  prices?: TierPrices | undefined;
  jsonMode?: JsonMode | undefined;
  extraBody?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

/** Builds the gateway from role config. `fake` is the default until real-model access (M1.5). */
export function gatewayFromConfig(cfg: {
  provider: LlmEnv['LLM_PROVIDER'];
  anthropicApiKey?: string | undefined;
  openAiCompat?: OpenAiCompatConfig | undefined;
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
  if (cfg.provider === 'openai-compat') {
    const c = cfg.openAiCompat ?? {};
    const small = c.models?.small;
    if (!c.baseUrl || !c.apiKey || !small) {
      throw new Error(
        'LLM_PROVIDER=openai-compat needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL_SMALL',
      );
    }
    return createGateway(
      openAiCompatRegistry({ ...c.models, small }, c.prices),
      [
        createOpenAiCompatProvider({
          baseUrl: c.baseUrl,
          apiKey: c.apiKey,
          jsonMode: c.jsonMode,
          extraBody: c.extraBody,
          timeoutMs: c.timeoutMs,
          maxRetries: c.maxRetries,
        }),
        createFakeProvider(),
      ],
      opts,
    );
  }
  return createGateway(defaultRegistry('fake'), [createFakeProvider(cfg.fakeScript)], opts);
}

/** The gateway from a role's parsed `envSchemas.llm` variables. */
export function gatewayFromEnv(
  env: LlmEnv,
  extras: { fakeScript?: FakeScript | undefined; onUsage?: UsageSink | undefined } = {},
): LlmGateway {
  return gatewayFromConfig({
    provider: env.LLM_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openAiCompat: {
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      models: {
        small: env.LLM_MODEL_SMALL,
        large: env.LLM_MODEL_LARGE,
        judge: env.LLM_MODEL_JUDGE,
      },
      prices: env.LLM_PRICES,
      jsonMode: env.LLM_JSON_MODE,
      extraBody: env.LLM_EXTRA_BODY,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    },
    ...extras,
  });
}
