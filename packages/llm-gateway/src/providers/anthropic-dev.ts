import Anthropic from '@anthropic-ai/sdk';
import type {
  GenerateRequest,
  ModelProvider,
  ProviderResult,
  ProviderStreamChunk,
} from '../types.js';

/** The part of the SDK client this provider uses, so tests can stub it. */
export interface AnthropicMessagesClient {
  messages: Pick<Anthropic['messages'], 'create' | 'stream'>;
}

/**
 * Anthropic API provider for development with TEST DATA ONLY (architecture Q1,
 * ADR-007 decision 5). Production inference goes through Bedrock's `au.` profile
 * (ADR-006), which MD adds as the `bedrock` provider. Enabled only when
 * LLM_PROVIDER=anthropic-dev and ANTHROPIC_API_KEY is set. Anthropic has no embedding
 * endpoint, so the registry keeps `embed` on the fake embedder with this provider.
 */
export function createAnthropicDevProvider(
  apiKey: string,
  client: AnthropicMessagesClient = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 }),
): ModelProvider {
  return {
    id: 'anthropic-dev',
    capabilities: {
      promptCaching: true,
      structuredOutputs: true,
      toolUse: true,
      streaming: true,
      maxContextTokens: 1_000_000,
    },
    async generate(req, providerModelId): Promise<ProviderResult> {
      const response = await client.messages.create(anthropicParams(req, providerModelId));
      return toResult(response, providerModelId);
    },
    async *stream(req, providerModelId): AsyncIterable<ProviderStreamChunk> {
      const stream = client.messages.stream(anthropicParams(req, providerModelId));
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
          yield { type: 'text', text: event.delta.text };
      }
      yield { type: 'done', result: toResult(await stream.finalMessage(), providerModelId) };
    },
  };
}

const ephemeral = { type: 'ephemeral' } as const;

/**
 * The ADR-007 cache layout on the Messages API: tools → system (breakpoint) → history
 * (breakpoint on its last message) → the tail and the visitor's message, uncached.
 */
export function anthropicParams(
  req: GenerateRequest,
  providerModelId: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const history = req.messages.slice(0, -1);
  const current = req.messages.at(-1);
  const messages: Anthropic.MessageParam[] = history.map((m, i) => ({
    role: m.role,
    content: [
      {
        type: 'text',
        text: m.content,
        ...(i === history.length - 1 ? { cache_control: ephemeral } : {}),
      },
    ],
  }));
  if (current) {
    const blocks: Anthropic.TextBlockParam[] = [];
    if (req.tail) blocks.push({ type: 'text', text: req.tail });
    blocks.push({ type: 'text', text: current.content });
    messages.push({ role: current.role, content: blocks });
  }
  return {
    model: providerModelId,
    max_tokens: req.maxTokens,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: { type: 'object' as const, ...t.inputSchema },
          })),
        }
      : {}),
    system: [{ type: 'text', text: req.system, cache_control: ephemeral }],
    output_config: req.outputSchema
      ? { effort: 'low', format: { type: 'json_schema', schema: req.outputSchema } }
      : { effort: 'low' },
    messages,
  };
}

function toResult(response: Anthropic.Message, providerModelId: string): ProviderResult {
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  const toolCalls = response.content.flatMap((block) =>
    block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
  const stop = response.stop_reason;
  return {
    text,
    toolCalls,
    stopReason:
      stop === 'end_turn'
        ? 'end'
        : stop === 'max_tokens' || stop === 'refusal' || stop === 'tool_use'
          ? stop
          : 'other',
    provider: 'anthropic-dev',
    providerModelId,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
