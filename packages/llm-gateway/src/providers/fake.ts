import type {
  GenerateRequest,
  ModelProvider,
  ProviderResult,
  ProviderStreamChunk,
  Usage,
} from '../types.js';
import { fakeEmbed } from './fake-embed.js';

/** A script returns the fake model's whole output for a request. */
export type FakeScript = (req: GenerateRequest) => string;

/**
 * Deterministic scripted provider for local development and tests (plan §2, P10).
 * Without a script it echoes. Streaming splits the output into small chunks, so the
 * agent's hold-back buffer sees slot tokens cut in half (ADR-008). Embeddings use the
 * hashed local embedder.
 */
export function createFakeProvider(
  script?: FakeScript,
  opts: { chunkSize?: number } = {},
): ModelProvider {
  const chunkSize = opts.chunkSize ?? 7;
  function run(req: GenerateRequest, providerModelId: string): ProviderResult {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = script ? script(req) : `Echo: ${last?.content ?? ''}`;
    return {
      text,
      toolCalls: [],
      stopReason: 'end',
      provider: 'fake',
      providerModelId,
      usage: usage(req, text),
    };
  }
  return {
    id: 'fake',
    capabilities: {
      promptCaching: false,
      structuredOutputs: false,
      toolUse: false,
      streaming: true,
      maxContextTokens: 1_000_000,
    },
    async generate(req, providerModelId) {
      return run(req, providerModelId);
    },
    async *stream(req, providerModelId): AsyncIterable<ProviderStreamChunk> {
      const result = run(req, providerModelId);
      for (let i = 0; i < result.text.length; i += chunkSize) {
        yield { type: 'text', text: result.text.slice(i, i + chunkSize) };
      }
      yield { type: 'done', result };
    },
    async embed(req, providerModelId) {
      return {
        vectors: req.texts.map(fakeEmbed),
        provider: 'fake',
        providerModelId,
        usage: { inputTokens: req.texts.reduce((n, t) => n + tokens(t), 0) },
      };
    },
  };
}

/** A script that returns each output in turn (first attempt, regeneration, …), repeating the last. */
export function scriptedOutputs(outputs: string[]): FakeScript {
  let i = 0;
  return () => outputs[Math.min(i++, outputs.length - 1)] ?? '';
}

/** About four characters per token: enough for a realistic cost estimate offline. */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The fake has no cache: every input token is uncached. */
function usage(req: GenerateRequest, text: string): Usage {
  return {
    inputTokens:
      tokens(req.system) +
      tokens(req.tail ?? '') +
      (req.tools ?? []).reduce((n, t) => n + tokens(JSON.stringify(t)), 0) +
      req.messages.reduce((n, m) => n + tokens(m.content), 0),
    outputTokens: tokens(text),
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}
