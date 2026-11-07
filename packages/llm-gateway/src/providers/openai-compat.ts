import type {
  GenerateRequest,
  ModelProvider,
  ProviderResult,
  ProviderStreamChunk,
  ToolCall,
} from '../types.js';

/** How structured output is asked for. The schema is also always written into the prompt. */
export type JsonMode = 'json_schema' | 'json_object' | 'none';

export interface OpenAiCompatOptions {
  /** e.g. `https://integrate.api.nvidia.com/v1` or `https://api.deepseek.com`. */
  baseUrl: string;
  apiKey: string;
  jsonMode?: JsonMode | undefined;
  /** Provider-specific fields merged into every request body; ours win on a clash. */
  extraBody?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  /** Retries on 429, 5xx and network errors, before any output is read. */
  maxRetries?: number | undefined;
  maxContextTokens?: number | undefined;
  /** Injected in tests. */
  fetch?: typeof fetch | undefined;
  /** Injected in tests so retries do not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Any OpenAI Chat Completions endpoint, for development with TEST DATA ONLY
 * (architecture Q1): the NVIDIA API catalog, DeepSeek, OpenRouter, a local vLLM. A route
 * carries tenant data only after it passes AGT-14 and C2/GOV-07/GOV-11 (ADR-007 d5).
 * Caching is the provider's own automatic prefix caching: the request keeps ADR-007's
 * byte-stable order (system → history → tail and visitor message last), so the prefix
 * repeats. No embedding endpoint: the registry keeps `embed` on the fake embedder.
 */
export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): ModelProvider {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxRetries = opts.maxRetries ?? 2;

  async function post(body: Record<string, unknown>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let error: unknown;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
            accept: body.stream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
      } catch (e) {
        error = e;
      }
      if (res?.ok) return res;
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        if (!res) throw error;
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`llm-gateway: openai-compat ${res.status} ${detail}`);
      }
      const after = Number(res?.headers.get('retry-after'));
      await sleep(
        Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt,
      );
    }
  }

  return {
    id: 'openai-compat',
    capabilities: {
      promptCaching: true,
      structuredOutputs: (opts.jsonMode ?? 'json_object') !== 'none',
      toolUse: true,
      streaming: true,
      maxContextTokens: opts.maxContextTokens ?? 128_000,
    },
    async generate(req, providerModelId): Promise<ProviderResult> {
      const res = await post(openAiCompatParams(req, providerModelId, opts));
      return toResult((await res.json()) as ChatCompletion, providerModelId);
    },
    async *stream(req, providerModelId): AsyncIterable<ProviderStreamChunk> {
      const res = await post({
        ...openAiCompatParams(req, providerModelId, opts),
        stream: true,
        stream_options: { include_usage: true },
      });
      if (!res.body) throw new Error('llm-gateway: openai-compat stream has no body');
      const think = thinkStripper();
      const tools = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | null = null;
      let usage: ChatUsage | undefined;
      let text = '';
      for await (const data of sseData(res.body)) {
        const chunk = JSON.parse(data) as ChatChunk;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finish = choice.finish_reason;
          for (const t of choice.delta?.tool_calls ?? []) {
            const acc = tools.get(t.index) ?? { id: '', name: '', args: '' };
            if (t.id) acc.id = t.id;
            if (t.function?.name) acc.name += t.function.name;
            if (t.function?.arguments) acc.args += t.function.arguments;
            tools.set(t.index, acc);
          }
          const delta = choice.delta?.content ? think.push(choice.delta.content) : '';
          if (delta) {
            text += delta;
            yield { type: 'text', text: delta };
          }
        }
      }
      const rest = think.end();
      if (rest) {
        text += rest;
        yield { type: 'text', text: rest };
      }
      yield {
        type: 'done',
        result: {
          text,
          toolCalls: [...tools.values()].map((t) => toolCall(t.id, t.name, t.args)),
          stopReason: stopReason(finish),
          provider: 'openai-compat',
          providerModelId,
          usage: toUsage(usage),
        },
      };
    },
  };
}

/** The request body. Exported for the layout tests. */
export function openAiCompatParams(
  req: GenerateRequest,
  providerModelId: string,
  opts: Pick<OpenAiCompatOptions, 'jsonMode' | 'extraBody'> = {},
): Record<string, unknown> {
  const jsonMode = opts.jsonMode ?? 'json_object';
  const system = req.outputSchema
    ? `${req.system}\n\nReply with only a JSON object, no prose and no code fence, matching this JSON Schema:\n${JSON.stringify(req.outputSchema)}`
    : req.system;
  const history = req.messages.slice(0, -1);
  const current = req.messages.at(-1);
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (current) {
    messages.push({
      role: current.role,
      content: req.tail ? `${req.tail}\n\n${current.content}` : current.content,
    });
  }
  return {
    ...opts.extraBody,
    model: providerModelId,
    max_tokens: req.maxTokens,
    messages,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: { type: 'object', ...t.inputSchema },
            },
          })),
        }
      : {}),
    ...(req.outputSchema && jsonMode === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'output', schema: req.outputSchema, strict: true },
          },
        }
      : req.outputSchema && jsonMode === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
  };
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek's own field. */
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface ChatCompletion {
  choices: {
    message: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[] | null;
    };
    finish_reason: string | null;
  }[];
  usage?: ChatUsage;
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage | null;
}

function toResult(response: ChatCompletion, providerModelId: string): ProviderResult {
  const choice = response.choices[0];
  return {
    text: stripThink(choice?.message.content ?? ''),
    toolCalls: (choice?.message.tool_calls ?? []).map((t) =>
      toolCall(t.id, t.function.name, t.function.arguments),
    ),
    stopReason: stopReason(choice?.finish_reason ?? null),
    provider: 'openai-compat',
    providerModelId,
    usage: toUsage(response.usage),
  };
}

/** A model's arguments that are not JSON stay a string, so the dispatcher rejects them. */
function toolCall(id: string, name: string, args: string): ToolCall {
  let input: unknown = args;
  try {
    input = args ? JSON.parse(args) : {};
  } catch {
    /* left as the raw string */
  }
  return { id, name, input };
}

function stopReason(finish: string | null): ProviderResult['stopReason'] {
  switch (finish) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** `inputTokens` excludes cached tokens (costOf); these providers charge no cache writes. */
function toUsage(u: ChatUsage | null | undefined): ProviderResult['usage'] {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = Math.min(
    u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0,
    prompt,
  );
  return {
    inputTokens: prompt - cached,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
  };
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** Some endpoints put reasoning inline in a leading `<think>` block; it never reaches a visitor. */
export function stripThink(text: string): string {
  const s = thinkStripper();
  return s.push(text) + s.end();
}

/** Streaming form of stripThink: holds text back only while a leading think block is possible. */
function thinkStripper() {
  let state: 'start' | 'thinking' | 'text' = 'start';
  let buf = '';
  return {
    push(delta: string): string {
      if (state === 'text') return delta;
      buf += delta;
      if (state === 'start') {
        const lead = buf.trimStart();
        if (lead.length < OPEN.length && OPEN.startsWith(lead)) return '';
        if (!lead.startsWith(OPEN)) {
          state = 'text';
          const out = buf;
          buf = '';
          return out;
        }
        state = 'thinking';
      }
      const close = buf.indexOf(CLOSE);
      if (close === -1) return '';
      state = 'text';
      const out = buf.slice(close + CLOSE.length).trimStart();
      buf = '';
      return out;
    },
    /** What is still held at the end: an unfinished think block is dropped. */
    end(): string {
      const out = state === 'start' ? buf : '';
      buf = '';
      return out;
    },
  };
}

/** The `data:` payloads of a server-sent event stream, up to `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield data;
    }
  }
}
