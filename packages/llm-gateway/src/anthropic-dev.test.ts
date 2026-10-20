import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createGateway, defaultRegistry, type GenerateRequest } from './index.js';
import { anthropicParams, createAnthropicDevProvider } from './providers/anthropic-dev.js';

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

describe('anthropic-dev request layout (ADR-007 decision 2, FEAT-004 AC-3)', () => {
  it('caches the system block and the history, and sends the tail uncached before the visitor text', () => {
    const p = anthropicParams(req, 'claude-haiku-5-5');
    expect(p.system).toEqual([
      { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
    ]);
    expect(p.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: req.tail },
          { type: 'text', text: 'how much is the cake?' },
        ],
      },
    ]);
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.tools).toBeUndefined();
  });

  it('puts no history breakpoint on a first message and sends no empty tail', () => {
    const p = anthropicParams(
      { ...req, tail: undefined, messages: [{ role: 'user', content: 'hi' }] },
      'm',
    );
    expect(p.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('asks for structured output and maps tools', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    const p = anthropicParams(
      {
        ...req,
        outputSchema: schema,
        tools: [
          { name: 'capture_lead', description: 'd', inputSchema: { properties: {}, required: [] } },
        ],
      },
      'm',
    );
    expect(p.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema },
    });
    expect(p.tools).toEqual([
      {
        name: 'capture_lead',
        description: 'd',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]);
  });

  it('returns tool calls, cache usage and the cost through the gateway', async () => {
    const message = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [
        { type: 'text', text: 'ok', citations: null },
        { type: 'tool_use', id: 'tu1', name: 'capture_lead', input: { name: 'Tan' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
    } as unknown as Anthropic.Message;
    const seen: unknown[] = [];
    const client = {
      messages: {
        create: async (p: unknown) => {
          seen.push(p);
          return message;
        },
        stream: () => {
          throw new Error('unused');
        },
      },
    } as unknown as Parameters<typeof createAnthropicDevProvider>[1];
    const gw = createGateway(defaultRegistry('anthropic-dev'), [
      createAnthropicDevProvider('key', client),
    ]);
    const res = await gw.generate(req);
    expect(seen).toHaveLength(1);
    expect(res.toolCalls).toEqual([{ id: 'tu1', name: 'capture_lead', input: { name: 'Tan' } }]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage.cacheReadInputTokens).toBe(1000);
    // Haiku: 100×0.1 + 1000×0.01 + 20×0.5 = 30 per million.
    expect(res.costUsd).toBeCloseTo(0.00003, 12);
  });
});
