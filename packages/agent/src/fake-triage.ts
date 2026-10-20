import type { GenerateRequest } from '@kaki/llm-gateway';
import { fakeVisitorResponder } from './fake-responder.js';
import type { TaskKind } from './plan.js';

/** Keyword rules for the fake triager, first match per kind. */
const RULES: [Exclude<TaskKind, 'answer'>, RegExp][] = [
  ['crisis', /\b(kill myself|suicide|end my life)\b|自杀|不想活/i],
  [
    'withdraw_consent',
    /\b(stop (contacting|messaging|calling)|unsubscribe|don'?t contact)\b|别再联系|不要再联系/i,
  ],
  [
    'data_request',
    /\b(delete|remove|see|correct) (my|all my) (data|details|personal)\b|删除我的(资料|数据)/i,
  ],
  [
    'escalate',
    /\b(talk|speak|chat) (to|with) (a |an )?(person|human|staff|someone|real)\b|真人|人工/i,
  ],
  [
    'request_commitment',
    /\b(quote|quotation|discount|cheaper|custom|can deliver|deliver(y)? on|bulk)\b|打折|折扣|报价|送货/i,
  ],
  [
    'capture_lead',
    /\b(my (number|phone|email|contact) is|call me at|whatsapp me)\b|我的电话|我的号码/i,
  ],
  ['handoff_channel', /\b(on|via|through) (telegram|whatsapp|email)\b/i],
];

/**
 * What the fake triage model returns in local development and E2E (plan §2, P10): a
 * deterministic plan from keywords, in the wire shape the real model writes. It is not
 * a classifier; the M1.5 gate measures the real one on the eval set.
 */
export function fakeTriage(req: GenerateRequest): string {
  const text = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const tasks: { kind: TaskKind; args: { name: string; value: string }[] }[] = [];
  const kinds = RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (
    !kinds.includes('crisis') &&
    /[?？]|\b(how much|got|what|when|where|price|open)\b|多少|几点|有没有/i.test(text)
  )
    tasks.push({ kind: 'answer', args: [] });
  for (const kind of kinds) tasks.push({ kind, args: [] });
  if (!tasks.length) tasks.push({ kind: 'answer', args: [] });
  const complex = kinds.includes('request_commitment') || (text.match(/\d+/g)?.length ?? 0) >= 3;
  const complaint = /\b(complain|terrible|disappointed|refund|worst)\b|投诉|太差/i.test(text);
  return JSON.stringify({
    language: /\p{Script=Han}/u.test(text) ? 'zh' : 'en',
    register: /\b(lah|leh|lor|can or not|got or not|meh)\b/i.test(text) ? 'singlish' : 'standard',
    complexity: complex ? 0.8 : 0.2,
    confidence: 0.9,
    flags: {
      complaint,
      injection: /ignore (all |your )?(previous |prior )?instructions/i.test(text),
    },
    tasks,
  });
}

/** The fake provider's script for the agent: triage plans for `triage`, slot answers otherwise. */
export function fakeAgentScript(req: GenerateRequest): string {
  return req.model === 'triage' ? fakeTriage(req) : fakeVisitorResponder(req);
}
