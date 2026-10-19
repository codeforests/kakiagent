import { createAnthropicDevProvider } from './providers/anthropic-dev.js';
import { createFakeProvider, type FakeScript } from './providers/fake.js';
import { defaultRegistry } from './registry.js';
import { createGateway, type LlmGateway } from './router.js';

export * from './types.js';
export {
  route,
  createGateway,
  type LlmGateway,
  type Purpose,
  type RouteContext,
} from './router.js';
export { defaultRegistry } from './registry.js';
export { createFakeProvider, scriptedOutputs, type FakeScript } from './providers/fake.js';
export { cosineSimilarity, fakeEmbed } from './providers/fake-embed.js';

/** Builds the gateway from role config. `fake` is the default until real-model access (M1.5). */
export function gatewayFromConfig(cfg: {
  provider: 'fake' | 'anthropic-dev';
  anthropicApiKey?: string | undefined;
  /** What the fake model writes; the agent passes its slot-aware responder (FEAT-022). */
  fakeScript?: FakeScript | undefined;
}): LlmGateway {
  if (cfg.provider === 'anthropic-dev') {
    if (!cfg.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic-dev needs ANTHROPIC_API_KEY');
    return createGateway(defaultRegistry('anthropic-dev'), [
      createAnthropicDevProvider(cfg.anthropicApiKey),
      createFakeProvider(),
    ]);
  }
  return createGateway(defaultRegistry('fake'), [createFakeProvider(cfg.fakeScript)]);
}
