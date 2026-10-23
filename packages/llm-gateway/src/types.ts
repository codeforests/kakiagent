/** Logical models (ADR-007 decision 5). Routing policy maps requests onto these. */
export type LogicalModel =
  | 'triage'
  | 'reply.simple'
  | 'reply.complex'
  | 'extract'
  /** Chat-export Q&A mining on Haiku 5.5 (ADR-007 decision 4; FEAT-017 §5.4). */
  | 'mine'
  | 'summarise'
  | 'judge'
  | 'embed';

export type ProviderId = 'fake' | 'anthropic-dev' | 'bedrock';

/** A tool the model may propose to call (ADR-025 decision 3). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call the model proposed: a proposal for the dispatcher, never a side effect. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Provider-neutral request, laid out for prompt caching (ADR-007 decision 2): tools →
 * system → breakpoint → history → breakpoint → tail → the current visitor message.
 */
export interface GenerateRequest {
  model: LogicalModel;
  /** The cached prefix: platform rules and the tenant block. Byte-stable: no timestamps or IDs. */
  system: string;
  /** The scope's full tool list, never varied per turn (ADR-025 decision 4). */
  tools?: ToolDefinition[] | undefined;
  /** History, oldest first, ending with the current visitor message. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  /**
   * This turn's context: retrieved facts, the current SGT time, regeneration notes.
   * Never cached, never stored in history, and not masked: it is the business's own data.
   */
  tail?: string | undefined;
  /** Structured output: the reply is JSON matching this schema (triage). */
  outputSchema?: Record<string, unknown> | undefined;
  maxTokens: number;
  /** IDs only, for the usage ledger and traces (ADR-021). */
  meta: { tenantId: string; conversationId?: string | undefined; turnId?: string | undefined };
}

/** Usage in one shape across providers, for the usage ledger (ADR-021, FEAT-004). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** What a provider returns; the gateway adds the cost. */
export interface ProviderResult {
  text: string;
  /** Empty until a feature defines tools (FEAT-049 onwards). */
  toolCalls: ToolCall[];
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'tool_use' | 'other';
  provider: ProviderId;
  providerModelId: string;
  usage: Usage;
}

export interface GenerateResult extends ProviderResult {
  /** USD at the registry price table (ADR-021). */
  costUsd: number;
}

/** A streamed reply: text deltas, then one `done` with the whole result. */
export type StreamChunk = { type: 'text'; text: string } | { type: 'done'; result: GenerateResult };
export type ProviderStreamChunk =
  { type: 'text'; text: string } | { type: 'done'; result: ProviderResult };

/** Embedding dimensions of every embedder: Cohere Embed Multilingual v3 (ADR-019). */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbedRequest {
  texts: string[];
  /** Cohere distinguishes stored documents from search queries. */
  purpose: 'document' | 'query';
  meta: { tenantId: string; conversationId?: string | undefined; turnId?: string | undefined };
}

export interface ProviderEmbedResult {
  /** One unit-length vector of EMBEDDING_DIMENSIONS per input text, in order. */
  vectors: number[][];
  provider: ProviderId;
  providerModelId: string;
  usage: { inputTokens: number };
}

export interface EmbedResult extends ProviderEmbedResult {
  costUsd: number;
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
  generate(req: GenerateRequest, providerModelId: string): Promise<ProviderResult>;
  /** Optional: the gateway falls back to one chunk from `generate`. */
  stream?(req: GenerateRequest, providerModelId: string): AsyncIterable<ProviderStreamChunk>;
  embed?(req: EmbedRequest, providerModelId: string): Promise<ProviderEmbedResult>;
}

/**
 * USD per million tokens. `cacheWrite` is the 5-minute write price; `multiplier` covers
 * a route premium (Bedrock's `au.` profile is list × 1.10, ADR-007).
 */
export interface PriceTable {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  multiplier?: number;
}

export interface RegistryEntry {
  provider: ProviderId;
  modelId: string;
  price: PriceTable;
}

export type UsagePurpose = 'triage' | 'reply' | 'extract' | 'summarise' | 'judge' | 'embed';

/** One usage-ledger row's worth, emitted after every call (ADR-021). IDs only. */
export interface UsageEvent {
  tenantId: string;
  conversationId: string | null;
  turnId: string | null;
  purpose: UsagePurpose;
  model: LogicalModel;
  provider: ProviderId;
  providerModelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  costUsd: number;
}

/** Records usage (the analytics ledger, or an eval's tally). Must not throw. */
export type UsageSink = (event: UsageEvent) => Promise<void>;

export type ModelRegistry = Record<LogicalModel, RegistryEntry>;
