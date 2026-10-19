/** Logical models (ADR-007 decision 5). Routing policy maps requests onto these. */
export type LogicalModel =
  'triage' | 'reply.simple' | 'reply.complex' | 'extract' | 'summarise' | 'judge';

export type ProviderId = 'fake' | 'anthropic-dev' | 'bedrock';

/** Provider-neutral request. Cache hints and tools arrive with FEAT-022 and FEAT-004. */
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
}

export interface RegistryEntry {
  provider: ProviderId;
  modelId: string;
}

export type ModelRegistry = Record<LogicalModel, RegistryEntry>;
