/** Logical models (ADR-007 decision 5). Routing policy maps requests onto these. */
export type LogicalModel =
  'triage' | 'reply.simple' | 'reply.complex' | 'extract' | 'summarise' | 'judge' | 'embed';

export type ProviderId = 'fake' | 'anthropic-dev' | 'bedrock';

/** Provider-neutral request. Cache hints and tools arrive with FEAT-004. */
export interface GenerateRequest {
  model: LogicalModel;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  /** IDs only, for the usage ledger and traces (ADR-021). */
  meta: { tenantId: string; conversationId?: string };
}

/** Usage in one shape across providers, for the usage ledger (ADR-021, FEAT-004). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface GenerateResult {
  text: string;
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  provider: ProviderId;
  providerModelId: string;
  usage: Usage;
}

/** A streamed reply: text deltas, then one `done` with the whole result. */
export type StreamChunk = { type: 'text'; text: string } | { type: 'done'; result: GenerateResult };

/** Embedding dimensions of every embedder: Cohere Embed Multilingual v3 (ADR-019). */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbedRequest {
  texts: string[];
  /** Cohere distinguishes stored documents from search queries. */
  purpose: 'document' | 'query';
  meta: { tenantId: string };
}

export interface EmbedResult {
  /** One unit-length vector of EMBEDDING_DIMENSIONS per input text, in order. */
  vectors: number[][];
  provider: ProviderId;
  providerModelId: string;
}

export interface ProviderCapabilities {
  promptCaching: boolean;
  structuredOutputs: boolean;
  toolUse: boolean;
  streaming: boolean;
  maxContextTokens: number;
}

/** What each provider implements. Adding a provider = one module + registry entries. */
export interface ModelProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  generate(req: GenerateRequest, providerModelId: string): Promise<GenerateResult>;
  /** Optional: the gateway falls back to one chunk from `generate`. */
  stream?(req: GenerateRequest, providerModelId: string): AsyncIterable<StreamChunk>;
  embed?(req: EmbedRequest, providerModelId: string): Promise<EmbedResult>;
}

export interface RegistryEntry {
  provider: ProviderId;
  modelId: string;
}

export type ModelRegistry = Record<LogicalModel, RegistryEntry>;
