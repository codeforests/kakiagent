import { createAnthropicDevProvider } from './providers/anthropic-dev.js';
import { createFakeProvider } from './providers/fake.js';
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
export { createFakeProvider } from './providers/fake.js';

/** Builds the gateway from role config. `fake` is the default until real-model access (M1.5). */
export function gatewayFromConfig(cfg: {
  provider: 'fake' | 'anthropic-dev';
  anthropicApiKey?: string | undefined;
}): LlmGateway {
  if (cfg.provider === 'anthropic-dev') {
    if (!cfg.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic-dev needs ANTHROPIC_API_KEY');
    return createGateway(defaultRegistry('anthropic-dev'), [
      createAnthropicDevProvider(cfg.anthropicApiKey),
    ]);
  }
  return createGateway(defaultRegistry('fake'), [createFakeProvider()]);
}
