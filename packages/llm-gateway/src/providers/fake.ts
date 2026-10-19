import type {
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamChunk,
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
  function run(req: GenerateRequest, providerModelId: string): GenerateResult {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = script ? script(req) : `Echo: ${last?.content ?? ''}`;
    return { text, stopReason: 'end', provider: 'fake', providerModelId, usage: usage(req, text) };
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
    async *stream(req, providerModelId): AsyncIterable<StreamChunk> {
      const result = run(req, providerModelId);
      for (let i = 0; i < result.text.length; i += chunkSize) {
        yield { type: 'text', text: result.text.slice(i, i + chunkSize) };
      }
      yield { type: 'done', result };
    },
    async embed(req, providerModelId) {
      return { vectors: req.texts.map(fakeEmbed), provider: 'fake', providerModelId };
    },
  };
}

/** A script that returns each output in turn (first attempt, regeneration, …), repeating the last. */
export function scriptedOutputs(outputs: string[]): FakeScript {
  let i = 0;
  return () => outputs[Math.min(i++, outputs.length - 1)] ?? '';
}

function usage(req: GenerateRequest, text: string): Usage {
  return {
    inputTokens:
      Math.ceil(req.system.length / 4) +
      req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0),
    outputTokens: Math.ceil(text.length / 4),
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}
