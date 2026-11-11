import type { GenerateRequest } from '@kaki/llm-gateway';
import { TRIAGE_TOPICS_BLOCKED } from './boundary.js';
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
    // FEAT-051 §5.3: EN, Singlish and Chinese ways to withdraw consent.
    /\b(stop (contacting|messaging|calling|texting)|stop using (\w+ ){0,2}my (details|number|data|info)|(don'?t|dun|do not) keep my (number|details)|(pls |please )?(don'?t|dun|do not) (call|contact|whatsapp|message|text) me|unsubscribe|no more (promos?|promotions|offers))\b|别再联系|不要再联系|不要用我的(资料|电话|号码)|取消订阅|不要再发/i,
  ],
  [
    'data_request',
    /\b(delete|remove|see|correct) (my|all my) (data|details|personal)\b|删除我的(资料|数据)/i,
  ],
  [
    'escalate',
    /\b(talk|speak|chat) (to|with) (a |an )?(person|human|staff|someone|real)\b|\b(can|could) (someone|somebody|a person) (call|contact|phone) me\b(?! back)|真人|人工/i,
  ],
  [
    'request_commitment',
    /\b(quote|quotation|discount|cheaper|custom|can deliver|deliver(y)? on|bulk)\b|打折|折扣|报价|送货/i,
  ],
  [
    'capture_lead',
    /\b(my (number|phone|email|contact|hp) is|call me (at|back)|whatsapp me|contact me|get back to me|leave my (details|number|contact))\b|我的电话|我的号码|我的邮箱|联系我/i,
  ],
  [
    'handoff_channel',
    // FEAT-038 §5.7: "continue on Telegram", "email me instead", 转到电报/邮件.
    /\b((on|via|through|over|to) (telegram|whatsapp|email)|continue (this |the chat )?(on|over|by|elsewhere)|email me( instead)?|move (this|the chat) to)\b|(在|用|转到)(电报|telegram|邮件|电邮)(上)?(继续|聊)/i,
  ],
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
 * The tail's blocked topics (FEAT-054 D2): any long word of a topic (its stem) in the message
 * stands in for the real model catching a paraphrase; CJK topics match as a substring.
 */
function blockedByTail(req: GenerateRequest, text: string): boolean {
  const line = req.tail?.split('\n').find((l) => l.startsWith(TRIAGE_TOPICS_BLOCKED));
  if (!line) return false;
  let topics: string[];
  try {
    topics = JSON.parse(line.slice(TRIAGE_TOPICS_BLOCKED.length)) as string[];
  } catch {
    return false;
  }
  const msg = text.toLowerCase();
  return topics.some((topic) =>
    /\p{Script=Han}/u.test(topic)
      ? msg.includes(topic)
      : topic
          .toLowerCase()
          .split(/[^\p{L}]+/u)
          .filter((w) => w.length >= 5)
          .some((w) => msg.includes(w.replace(/s$/, ''))),
  );
}

/**
 * What the fake triage model returns in local development and E2E (plan §2, P10): a
 * deterministic plan from keywords, in the wire shape the real model writes. It is not
 * a classifier; the M1.5 gate measures the real one on the eval set.
 */
/** `capture_lead`'s args as a model would read them: unchecked (FEAT-049 drops the invalid). */
function leadArgs(text: string): { name: string; value: string }[] {
  const args: { name: string; value: string }[] = [];
  const name = /\b(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/.exec(text)?.[1];
  if (name) args.push({ name: 'name', value: name });
  const phone = /(\+?\d[\d -]{5,14}\d)/.exec(text)?.[1];
  if (phone) args.push({ name: 'phone', value: phone.trim() });
  const email = /([^\s@]+@[^\s@]+)/.exec(text)?.[1]?.replace(/[.,]$/, '');
  if (email) args.push({ name: 'email', value: email });
  return args;
}

/**
 * `request_commitment`'s args (FEAT-055): the request text as `items` (approvals matches product
 * names in it), the first number as `quantity`, a percentage as `discount`, a day as `date`.
 */
function commitmentArgs(text: string): { name: string; value: string }[] {
  const args = [{ name: 'items', value: text.slice(0, 200) }];
  const pct = /(\d{1,3})\s*(%|percent|巴仙)|(\d)\s*折/i.exec(text);
  const discount = pct ? (pct[1] ?? String(100 - Number(pct[3]) * 10)) : null;
  const quantity = /\d[\d,]*/.exec(pct ? text.replace(pct[0], ' ') : text)?.[0]?.replace(/,/g, '');
  if (quantity) args.push({ name: 'quantity', value: quantity });
  if (discount) args.push({ name: 'discount', value: discount });
  const date =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b|今天|明天|后天|星期.|周[一二三四五六日天]/i.exec(
      text,
    )?.[0];
  if (date) args.push({ name: 'date', value: date });
  return args;
}

export function fakeTriage(req: GenerateRequest): string {
  const text = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const tasks: { kind: TaskKind; args: { name: string; value: string }[] }[] = [];
  const kinds = RULES.filter(([, re]) => re.test(text))
    .map(([k]) => k)
    // "don't contact me" also reads as "contact me": a withdrawal is never a lead (FEAT-051).
    .filter((k, _i, all) => !(k === 'capture_lead' && all.includes('withdraw_consent')));
  const topic = blockedByTail(req, text) ? 'blocked' : TOPICS.find(([, re]) => re.test(text))?.[0];
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
      args:
        kind === 'out_of_scope' && topic
          ? [{ name: 'topic', value: topic }]
          : kind === 'capture_lead'
            ? leadArgs(text)
            : kind === 'request_commitment'
              ? commitmentArgs(text)
              : [],
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
