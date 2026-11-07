import { describe, expect, it } from 'vitest';
import {
  createGateway,
  gatewayFromConfig,
  gatewayFromEnv,
  openAiCompatRegistry,
  type GenerateRequest,
} from './index.js';
import {
  createOpenAiCompatProvider,
  openAiCompatParams,
  stripThink,
} from './providers/openai-compat.js';

const req: GenerateRequest = {
  model: 'reply.simple',
  system: 'platform rules and tenant block',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'how much is the cake?' },
  ],
  tail: '<facts>\n[f:abcd1234] product …\n</facts>',
  maxTokens: 600,
  meta: { tenantId: 't' },
};

/** A fetch stub that records each body and answers from a queue of responses. */
function stubFetch(responses: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(init.headers as Record<string, string>);
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { fn, bodies, urls, headers };
}

const completion =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sse(events: unknown[]): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          // Split mid-line so the parser has to buffer across reads.
          const text =
            events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
          for (let i = 0; i < text.length; i += 17) c.enqueue(enc.encode(text.slice(i, i + 17)));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

const registry = openAiCompatRegistry(
  { small: 'deepseek-ai/deepseek-v4.1-flash' },
  { small: { input: 0.15, cacheRead: 0.003, output: 0.6 } },
);

describe('openai-compat request layout (ADR-007 decision 2)', () => {
  it('keeps the prefix stable: system, history, then the tail before the visitor text', () => {
    const p = openAiCompatParams(req, 'm');
    expect(p.messages).toEqual([
      { role: 'system', content: req.system },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: `${req.tail}\n\nhow much is the cake?` },
    ]);
    expect(p.model).toBe('m');
    expect(p.max_tokens).toBe(600);
    expect(p.response_format).toBeUndefined();
    expect(p.tools).toBeUndefined();
  });

  it('writes the schema into the prompt and asks for the configured JSON mode', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const obj = openAiCompatParams({ ...req, outputSchema: schema }, 'm');
    expect(obj.response_format).toEqual({ type: 'json_object' });
    const system = (obj.messages as { content: string }[])[0]!.content;
    expect(system.startsWith(req.system)).toBe(true);
    expect(system).toContain('JSON');
    expect(system).toContain(JSON.stringify(schema));

    const strict = openAiCompatParams({ ...req, outputSchema: schema }, 'm', {
      jsonMode: 'json_schema',
    });
    expect(strict.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'output', schema, strict: true },
    });
    const none = openAiCompatParams({ ...req, outputSchema: schema }, 'm', { jsonMode: 'none' });
    expect(none.response_format).toBeUndefined();
  });

  it('maps tools and merges extra body fields without letting them override ours', () => {
    const p = openAiCompatParams(
      {
        ...req,
        tools: [{ name: 'capture_lead', description: 'd', inputSchema: { properties: {} } }],
      },
      'm',
      { extraBody: { chat_template_kwargs: { thinking: false }, model: 'other' } },
    );
    expect(p.chat_template_kwargs).toEqual({ thinking: false });
    expect(p.model).toBe('m');
    expect(p.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'capture_lead',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });
});

describe('openai-compat provider', () => {
  it('returns text, tool calls, cached usage and the cost through the gateway', async () => {
    const f = stubFetch([
      completion({
        choices: [
          {
            message: {
              content: '<think>reasoning</think>\nok',
              tool_calls: [
                { id: 'c1', function: { name: 'capture_lead', arguments: '{"name":"Tan"}' } },
                { id: 'c2', function: { name: 'escalate', arguments: 'not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 1100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      }),
    ]);
    const gw = createGateway(registry, [
      createOpenAiCompatProvider({ baseUrl: 'https://example.test/v1/', apiKey: 'k', fetch: f.fn }),
    ]);
    const res = await gw.generate(req);
    expect(f.urls).toEqual(['https://example.test/v1/chat/completions']);
    expect(f.headers[0]!.authorization).toBe('Bearer k');
    expect(res.text).toBe('ok');
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'capture_lead', input: { name: 'Tan' } },
      { id: 'c2', name: 'escalate', input: 'not json' },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.provider).toBe('openai-compat');
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 1000,
      cacheWriteInputTokens: 0,
    });
    // 100×0.15 + 1000×0.003 + 20×0.6 = 30 per million.
    expect(res.costUsd).toBeCloseTo(0.00003, 12);
  });

  it("reads DeepSeek's own cache-hit field and maps finish reasons", async () => {
    const f = stubFetch([
      completion({
        choices: [{ message: { content: '{"a":1}' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 40 },
      }),
    ]);
    const provider = createOpenAiCompatProvider({
      baseUrl: 'https://x.test',
      apiKey: 'k',
      fetch: f.fn,
    });
    const res = await provider.generate(req, 'm');
    expect(res.stopReason).toBe('max_tokens');
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.cacheReadInputTokens).toBe(40);
  });

  it('retries 429 and 5xx, then fails clearly without leaking the key', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = completion({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const busy = () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
    const f = stubFetch([busy, completion({}, 503), ok]);
    const provider = createOpenAiCompatProvider({
      baseUrl: 'https://x.test',
      apiKey: 'secret-key',
      fetch: f.fn,
      sleep,
    });
    expect((await provider.generate(req, 'm')).text).toBe('ok');
    expect(waits).toEqual([2000, 1000]);

    const bad = stubFetch([completion({ error: 'bad model' }, 400)]);
    const failing = createOpenAiCompatProvider({
      baseUrl: 'https://x.test',
      apiKey: 'secret-key',
      fetch: bad.fn,
      sleep,
    });
    const err = await failing.generate(req, 'm').catch((e: Error) => e);
    expect(String(err)).toMatch(/openai-compat 400/);
    expect(String(err)).not.toContain('secret-key');
    expect(bad.bodies).toHaveLength(1);
  });

  it('streams deltas without the think block, then one done with usage', async () => {
    const f = stubFetch([
      sse([
        { choices: [{ delta: { content: '<thi' } }] },
        { choices: [{ delta: { content: 'nk>plan</th' } }] },
        { choices: [{ delta: { content: 'ink>Hello' } }] },
        { choices: [{ delta: { content: ' there' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 't1', function: { name: 'escalate', arguments: '{"a"' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
      ]),
    ]);
    const gw = createGateway(registry, [
      createOpenAiCompatProvider({ baseUrl: 'https://x.test', apiKey: 'k', fetch: f.fn }),
    ]);
    const texts: string[] = [];
    let done: Awaited<ReturnType<typeof gw.generate>> | undefined;
    for await (const c of gw.stream(req)) {
      if (c.type === 'text') texts.push(c.text);
      else done = c.result;
    }
    expect(f.bodies[0]!.stream).toBe(true);
    expect(f.bodies[0]!.stream_options).toEqual({ include_usage: true });
    expect(texts.join('')).toBe('Hello there');
    expect(done?.text).toBe('Hello there');
    expect(done?.toolCalls).toEqual([{ id: 't1', name: 'escalate', input: { a: 1 } }]);
    expect(done?.stopReason).toBe('end');
    expect(done?.usage.outputTokens).toBe(4);
  });

  it('strips only a leading think block', () => {
    expect(stripThink('plain')).toBe('plain');
    expect(stripThink('  <think>x</think>  answer')).toBe('answer');
    expect(stripThink('a <think>x</think>')).toBe('a <think>x</think>');
    expect(stripThink('<think>never closed')).toBe('');
    expect(stripThink('<th')).toBe('<th');
  });
});

describe('openai-compat configuration', () => {
  it('maps the tiers onto the logical models, with free pricing by default', () => {
    const r = openAiCompatRegistry({ small: 's', large: 'l' });
    expect([
      r.triage.modelId,
      r['reply.simple'].modelId,
      r.mine.modelId,
      r.summarise.modelId,
    ]).toEqual(['s', 's', 's', 's']);
    expect([r['reply.complex'].modelId, r.extract.modelId, r.judge.modelId]).toEqual([
      'l',
      'l',
      'l',
    ]);
    expect(r.triage.price).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(r.embed.provider).toBe('fake');
    expect(openAiCompatRegistry({ small: 's' })['reply.complex'].modelId).toBe('s');
  });

  it('refuses to start without a base URL, key and small model', () => {
    expect(() => gatewayFromConfig({ provider: 'openai-compat' })).toThrow(
      /LLM_BASE_URL, LLM_API_KEY and LLM_MODEL_SMALL/,
    );
    expect(() =>
      gatewayFromEnv({
        LLM_PROVIDER: 'openai-compat',
        LLM_BASE_URL: 'https://integrate.api.nvidia.com/v1',
        LLM_API_KEY: 'k',
        LLM_MODEL_SMALL: 'deepseek-ai/deepseek-v4.1-flash',
        LLM_JSON_MODE: 'json_object',
        LLM_TIMEOUT_MS: 60_000,
        LLM_MAX_RETRIES: 2,
      }),
    ).not.toThrow();
  });
});
