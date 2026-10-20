import { piiMask } from '@kaki/platform/pii-mask';
import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LogicalModel,
  ModelProvider,
  ModelRegistry,
  PriceTable,
  ProviderId,
  ProviderResult,
  StreamChunk,
  Usage,
  UsagePurpose,
  UsageSink,
} from './types.js';

export interface LlmGateway {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Streams text deltas, then `done` (CHN-02). Callers hold text back until verified (ADR-008). */
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

export interface GatewayOptions {
  /** Every call's usage goes here (the ADR-021 ledger); wired by the role (FEAT-004 D11). */
  onUsage?: UsageSink | undefined;
}

/** USD for one call at a price table (FEAT-004 §5.1). `inputTokens` excludes cached tokens. */
export function costOf(usage: Usage, price: PriceTable): number {
  const perMillion =
    usage.inputTokens * price.input +
    usage.cacheWriteInputTokens * price.cacheWrite +
    usage.cacheReadInputTokens * price.cacheRead +
    usage.outputTokens * price.output;
  return (perMillion / 1e6) * (price.multiplier ?? 1);
}

export function purposeOf(model: LogicalModel): UsagePurpose {
  return model === 'reply.simple' || model === 'reply.complex' ? 'reply' : model;
}

/**
 * GOV-04 backstop (FEAT-003 D3): visitor content is masked before any provider sees it,
 * whoever built the request. Callers already send masked text, so this is a no-op for
 * them. The system prompt, the tail and assistant turns carry the business's own
 * approved facts (a PayNow bank account, say) and are left alone (FEAT-004 D2).
 */
function maskGenerate(req: GenerateRequest): GenerateRequest {
  return {
    ...req,
    messages: req.messages.map((m) =>
      m.role === 'user' ? { ...m, content: piiMask(m.content) } : m,
    ),
  };
}

function maskEmbed(req: EmbedRequest): EmbedRequest {
  return req.purpose === 'query' ? { ...req, texts: req.texts.map(piiMask) } : req;
}

/** The single entry point other modules use. No module outside llm-gateway imports a provider SDK. */
export function createGateway(
  registry: ModelRegistry,
  providers: ModelProvider[],
  opts: GatewayOptions = {},
): LlmGateway {
  const byId = new Map<ProviderId, ModelProvider>(providers.map((p) => [p.id, p]));
  function resolve(model: LogicalModel) {
    const entry = registry[model];
    const provider = byId.get(entry.provider);
    if (!provider) throw new Error(`llm-gateway: provider ${entry.provider} is not configured`);
    return { provider, modelId: entry.modelId, price: entry.price };
  }
  async function record(
    model: LogicalModel,
    meta: GenerateRequest['meta'],
    result: Pick<GenerateResult, 'provider' | 'providerModelId' | 'usage' | 'costUsd'>,
  ) {
    await opts.onUsage?.({
      tenantId: meta.tenantId,
      conversationId: meta.conversationId ?? null,
      turnId: meta.turnId ?? null,
      purpose: purposeOf(model),
      model,
      provider: result.provider,
      providerModelId: result.providerModelId,
      ...result.usage,
      costUsd: result.costUsd,
    });
  }
  async function priced(req: GenerateRequest, raw: ProviderResult, price: PriceTable) {
    const result: GenerateResult = { ...raw, costUsd: costOf(raw.usage, price) };
    await record(req.model, req.meta, result);
    return result;
  }
  return {
    async generate(raw) {
      const req = maskGenerate(raw);
      const { provider, modelId, price } = resolve(req.model);
      return priced(req, await provider.generate(req, modelId), price);
    },
    async *stream(raw) {
      const req = maskGenerate(raw);
      const { provider, modelId, price } = resolve(req.model);
      if (!provider.stream) {
        const result = await priced(req, await provider.generate(req, modelId), price);
        yield { type: 'text', text: result.text };
        yield { type: 'done', result };
        return;
      }
      for await (const chunk of provider.stream(req, modelId)) {
        if (chunk.type === 'text') yield chunk;
        else yield { type: 'done', result: await priced(req, chunk.result, price) };
      }
    },
    async embed(raw) {
      const req = maskEmbed(raw);
      const { provider, modelId, price } = resolve('embed');
      if (!provider.embed) throw new Error(`llm-gateway: provider ${provider.id} cannot embed`);
      const out = await provider.embed(req, modelId);
      const usage: Usage = {
        inputTokens: out.usage.inputTokens,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      };
      const result: EmbedResult = { ...out, costUsd: costOf(usage, price) };
      await record('embed', req.meta, { ...result, usage });
      return result;
    },
  };
}
