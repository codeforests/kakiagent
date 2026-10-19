import type {
  GenerateRequest,
  GenerateResult,
  LogicalModel,
  ModelProvider,
  ModelRegistry,
  ProviderId,
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
}

/** The single entry point other modules use. No module outside llm-gateway imports a provider SDK. */
export function createGateway(registry: ModelRegistry, providers: ModelProvider[]): LlmGateway {
  const byId = new Map<ProviderId, ModelProvider>(providers.map((p) => [p.id, p]));
  return {
    async generate(req) {
      const entry = registry[req.model];
      const provider = byId.get(entry.provider);
      if (!provider) throw new Error(`llm-gateway: provider ${entry.provider} is not configured`);
      return provider.generate(req, entry.modelId);
    },
  };
}
