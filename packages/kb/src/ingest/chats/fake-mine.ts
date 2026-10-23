import type { GenerateRequest } from '@kaki/llm-gateway';

/**
 * The fake model's miner (FEAT-017 §5.4): a `Customer:` line ending in a question mark,
 * followed by a `Business:` line, is a pair with the business's line as answer and quote.
 * Deterministic, so the chat import runs end to end without a real model; the mining evals
 * measure a real model's judgement.
 */
export function fakeMineScript(req: GenerateRequest): string {
  const part = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lines = part.split('\n');
  const pairs: Record<string, unknown>[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const q = /^Customer: (.+[?？])$/.exec(lines[i]!);
    const a = /^Business: (.+)$/.exec(lines[i + 1]!);
    if (q && a) pairs.push({ question: q[1], answer: a[1], quote: a[1], confidence: 0.8 });
  }
  return JSON.stringify({ pairs });
}
