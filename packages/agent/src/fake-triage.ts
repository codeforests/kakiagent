import type { GenerateRequest } from '@kaki/llm-gateway';
import { COACH_TRIAGE_SYSTEM } from './coach-prompt.js';
import { fakeCoachTriage, fakeProposal } from './fake-coach.js';
import { fakeVisitorResponder } from './fake-responder.js';
import { PROPOSE_SYSTEM } from './propose.js';
import type { TaskKind } from './plan.js';

/** Keyword rules for the fake triager, first match per kind. */
const RULES: [Exclude<TaskKind, 'answer'>, RegExp][] = [
  [
    'crisis',
    /\b(kill myself|killing myself|suicid\w*|end my life|hurt myself|want to die|self[- ]harm)\b|自杀|不想活|想死|轻生/i,
  ],
  [
    'abuse',
    /\b(idiot|stupid|useless (bot|thing)|shut up|f+u+c+k\w*|bitch|moron|dumb bot)\b|笨蛋|白痴|垃圾|去你的/i,
  ],
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
  [
    'out_of_scope',
    /\b(homework|weather|election|politics|stock prices?|bitcoin|write (me )?(a |an )?(poem|essay|code|story)|football|lottery|toto|4d)\b|天气|作业|股票|选举|写一首诗/i,
  ],
];

/** `out_of_scope` topics (FEAT-025 D3), first match wins. */
const TOPICS: [string, RegExp][] = [
  [
    'illegal',
    /\b(fake (receipt|invoice|mc|medical certificate)|forge\w*|drugs?|weed|hack\w*|steal|launder\w*)\b|假发票|假收据|毒品/i,
  ],
  [
    'medical',
    /\b(doctor|medicine|medication|panadol|diagnos\w*|symptoms?|dosage|prescription)\b|看医生|吃药|药物|症状/i,
  ],
  ['legal', /\b(lawyer|sue|lawsuit|legal advice|contract dispute)\b|律师|起诉/i],
  ['financial', /\b(invest\w*|crypto\w*|loan|which stocks?|retirement fund|cpf)\b|投资|理财|贷款/i],
];

/** Flags (FEAT-025): an attempt to change or reveal the instructions; a claim to be staff. */
const INJECTION =
  /\b(ignore (all |your |the )?(previous |prior |above )?(instructions|rules)|system prompt|your (instructions|rules|prompt)|developer mode|jailbreak|pretend (you are|to be)|you are now|act as|DAN)\b|忽略(之前|以上|所有)?的?(指令|规则)|系统提示/i;
const IMPERSONATION =
  /\b(i'?m|i am|this is) (the )?(owner|boss|manager|admin|staff|developer)\b|\b(show|give|list|send)( me)? (the |all |today'?s )?(leads|customers|customer list|contacts|orders of others|settings|costs?)\b|我是老板|我是(这里的)?员工|客户名单/i;

/**
 * What the fake triage model returns in local development and E2E (plan §2, P10): a
 * deterministic plan from keywords, in the wire shape the real model writes. It is not
 * a classifier; the M1.5 gate measures the real one on the eval set.
 */
export function fakeTriage(req: GenerateRequest): string {
  const text = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const tasks: { kind: TaskKind; args: { name: string; value: string }[] }[] = [];
  const kinds = RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  const topic = TOPICS.find(([, re]) => re.test(text))?.[0];
  if (topic && !kinds.includes('out_of_scope')) kinds.push('out_of_scope');
  // A question goes with an answer task; beside an advice or illegal topic, only a
  // question about the business does (FEAT-025).
  const question = topic
    ? /\b(how much|price|got|open|cake|kueh|deliver)\b|多少|几点|有没有|蛋糕/i
    : /[?？]|\b(how much|got|what|when|where|price|open)\b|多少|几点|有没有/i;
  if (!kinds.includes('crisis') && question.test(text)) tasks.push({ kind: 'answer', args: [] });
  for (const kind of kinds)
    tasks.push({
      kind,
      args: kind === 'out_of_scope' && topic ? [{ name: 'topic', value: topic }] : [],
    });
  if (!tasks.length) tasks.push({ kind: 'answer', args: [] });
  const complex = kinds.includes('request_commitment') || (text.match(/\d+/g)?.length ?? 0) >= 3;
  const complaint = /\b(complain|terrible|disappointed|refund|worst)\b|投诉|太差/i.test(text);
  return JSON.stringify({
    language: /\p{Script=Han}/u.test(text) ? 'zh' : 'en',
    register: /\b(lah|leh|lor|can or not|got or not|meh)\b/i.test(text) ? 'singlish' : 'standard',
    complexity: complex ? 0.8 : 0.2,
    confidence: 0.9,
    flags: { complaint, injection: INJECTION.test(text), impersonation: IMPERSONATION.test(text) },
    tasks,
  });
}

/**
 * The fake provider's script for the agent: triage plans for `triage` (coaching's own for
 * its prompt), proposals for the propose step (FEAT-027), slot answers otherwise.
 */
export function fakeAgentScript(req: GenerateRequest): string {
  if (req.system === PROPOSE_SYSTEM) return fakeProposal(req);
  if (req.model !== 'triage') return fakeVisitorResponder(req);
  return req.system === COACH_TRIAGE_SYSTEM ? fakeCoachTriage(req) : fakeTriage(req);
}
