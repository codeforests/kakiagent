import { piiMask } from '@kaki/platform/pii-mask';
import type {
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  LogicalModel,
  ModelProvider,
  ModelRegistry,
  ProviderId,
  StreamChunk,
} from './types.js';

export type Purpose = 'triage' | 'reply' | 'extract' | 'summarise' | 'judge';

export interface RouteContext {
  /** Triage complexity score 0..1; FEAT-004 adds tenant thresholds and the cost governor. */
  complexity?: number;
}

/**
 * Picks the logical model for a request (ADR-007 decision 1, 3). Skeleton policy:
 * every reply is `reply.simple`; FEAT-004 adds triage-driven routing, per-tenant
 * thresholds and the cost governor.
 */
export function route(purpose: Purpose, _ctx: RouteContext = {}): LogicalModel {
  switch (purpose) {
    case 'reply':
      return 'reply.simple';
    default:
      return purpose;
  }
}

export interface LlmGateway {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Streams text deltas, then `done` (CHN-02). Callers hold text back until verified (ADR-008). */
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

/**
 * GOV-04 backstop (FEAT-003 D3): visitor content is masked before any provider sees it,
 * whoever built the request. Callers already send masked text, so this is a no-op for
 * them. The system prompt and assistant turns carry the business's own approved facts
 * (a PayNow bank account, say) and are left alone.
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
export function createGateway(registry: ModelRegistry, providers: ModelProvider[]): LlmGateway {
  const byId = new Map<ProviderId, ModelProvider>(providers.map((p) => [p.id, p]));
  function resolve(model: LogicalModel) {
    const entry = registry[model];
    const provider = byId.get(entry.provider);
    if (!provider) throw new Error(`llm-gateway: provider ${entry.provider} is not configured`);
    return { provider, modelId: entry.modelId };
  }
  return {
    async generate(raw) {
      const req = maskGenerate(raw);
      const { provider, modelId } = resolve(req.model);
      return provider.generate(req, modelId);
    },
    async *stream(raw) {
      const req = maskGenerate(raw);
      const { provider, modelId } = resolve(req.model);
      if (provider.stream) {
        yield* provider.stream(req, modelId);
        return;
      }
      const result = await provider.generate(req, modelId);
      yield { type: 'text', text: result.text };
      yield { type: 'done', result };
    },
    async embed(raw) {
      const req = maskEmbed(raw);
      const { provider, modelId } = resolve('embed');
      if (!provider.embed) throw new Error(`llm-gateway: provider ${provider.id} cannot embed`);
      return provider.embed(req, modelId);
    },
  };
}
