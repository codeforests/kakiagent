import type { GenerateRequest } from '@kaki/llm-gateway';
import { COACH_TRIAGE_SYSTEM } from './coach-prompt.js';
import { fakeVisitorResponder } from './fake-responder.js';
import { fakeTriage } from './fake-triage.js';
import { PROPOSE_SYSTEM } from './propose.js';

/**
 * The fake provider's coaching scripts (FEAT-027 §5.2): deterministic stand-ins for the
 * coaching triage and the propose step, for local development, tests, E2E and the eval
 * runner. Keyword rules, not a classifier; the real models are measured on the eval set.
 */

const STRONG =
  /\b(went (up|down)|has changed|changed|actually|should be|should say|is wrong|wrong|now costs?|no longer|ends? on|extend\w*|from now|we'?re open)\b|改成|应该是|涨到|涨价|降到|现在是|不对|错了|加一个/i;
const WEAK = /\b(now|add|update)\b|现在/i;

const lastUser = (req: GenerateRequest) =>
  [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/** Coaching triage: a correction is `correct`; anything else is triaged like a visitor message. */
export function fakeCoachTriage(req: GenerateRequest): string {
  const text = lastUser(req);
  const question = /[?？]\s*$/.test(text.trim());
  if (STRONG.test(text) || (!question && WEAK.test(text)) || /^\s*Q:.*A:/is.test(text))
    return JSON.stringify({
      language: /\p{Script=Han}/u.test(text) ? 'zh' : 'en',
      register: /\b(lah|leh|lor|liao|hor)\b/i.test(text) ? 'singlish' : 'standard',
      complexity: 0.3,
      confidence: 0.9,
      flags: { complaint: false, injection: false, impersonation: false },
      tasks: [{ kind: 'correct', args: [] }],
    });
  return fakeTriage(req);
}

interface Cand {
  ref: string;
  type: string;
  fields: Record<string, string>;
}

function candidates(content: string): Cand[] {
  const block = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(content)?.[1] ?? '';
  return [...block.matchAll(/^(F\d) (product|faq|policy|promotion) \| (.*)$/gm)].map(
    ([, ref, type, rest = '']) => ({
      ref: ref!,
      type: type!,
      fields: Object.fromEntries(
        rest.split(' | ').map((p) => {
          const i = p.indexOf(': ');
          return [p.slice(0, i), p.slice(i + 2)];
        }),
      ),
    }),
  );
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
const hanBigrams = (s: string) => {
  const han = [...s].filter((c) => /\p{Script=Han}/u.test(c)).join('');
  return new Set(
    Array.from({ length: Math.max(han.length - 1, 0) }, (_, i) => han.slice(i, i + 2)),
  );
};

/** The candidate whose label shares the most words with the message, of the given types. */
function best(msg: string, cands: Cand[], types: string[]): Cand | null {
  const mw = words(msg);
  const mh = hanBigrams(msg);
  let top: Cand | null = null;
  let score = 0;
  for (const c of cands.filter((x) => types.includes(x.type))) {
    const label = c.fields.name ?? c.fields.question ?? c.fields.title ?? '';
    const s =
      [...words(label)].filter((w) => mw.has(w)).length +
      [...hanBigrams(label)].filter((w) => mh.has(w)).length;
    if (s > score) [top, score] = [c, s];
  }
  return top;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function endDate(msg: string): string | null {
  const iso = /\b(20\d\d-\d\d-\d\d)\b/.exec(msg)?.[1];
  if (iso) return iso;
  const m = /\b(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* (20\d\d)\b/i.exec(
    msg,
  );
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/** 12-hour clock to 24-hour `HH:MM`; `ap` is am/pm or 上午/下午. */
function clock(h: string, min: string | undefined, ap: string): string {
  const hour = (Number(h) % 12) + (/pm|下午|晚上/i.test(ap) ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${min ?? '00'}`;
}

const DAY_WORDS: [RegExp, string[]][] = [
  [/weekends?|周末/i, ['sat', 'sun']],
  [/weekdays?|平日|工作日/i, ['mon', 'tue', 'wed', 'thu', 'fri']],
  [/mondays?|周一|星期一/i, ['mon']],
  [/tuesdays?|周二|星期二/i, ['tue']],
  [/wednesdays?|周三|星期三/i, ['wed']],
  [/thursdays?|周四|星期四/i, ['thu']],
  [/fridays?|周五|星期五/i, ['fri']],
  [/saturdays?|周六|星期六/i, ['sat']],
  [/sundays?|周日|星期天|星期日/i, ['sun']],
];

function hours(msg: string): { day: string; value: string }[] | null {
  const en =
    /(\d{1,2})(?:[:.](\d\d))?\s*(am|pm)?\s*(?:to|-|until|till)\s*(\d{1,2})(?:[:.](\d\d))?\s*(am|pm)?/i.exec(
      msg,
    );
  const zh = /(上午|早上)?(\d{1,2})点(?:半)?\s*(?:到|至)\s*(下午|晚上)?(\d{1,2})点/.exec(msg);
  let range: string | null = null;
  if (en && /\b(open|close|hours?)\b/i.test(msg))
    range = `${clock(en[1]!, en[2], en[3] ?? 'am')}-${clock(en[4]!, en[5], en[6] ?? 'pm')}`;
  else if (zh)
    range = `${clock(zh[2]!, undefined, zh[1] ?? '上午')}-${clock(zh[4]!, undefined, zh[3] ?? '下午')}`;
  const closed = /\b(closed|close) on\b|休息|不营业/i.test(msg);
  if (!range && !closed) return null;
  const days = DAY_WORDS.filter(([re]) => re.test(msg)).flatMap(([, d]) => d);
  const all = days.length ? [...new Set(days)] : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  return all.map((day) => ({ day, value: range ?? 'closed' }));
}

const none = () =>
  JSON.stringify({ action: 'none', ref: '', changes: [], question: '', answer: '', hours: [] });

/** The propose step: a deterministic proposal from the owner message and the candidates. */
export function fakeProposal(req: GenerateRequest): string {
  const content = lastUser(req);
  const msg = /<owner_message>\n([\s\S]*?)\n<\/owner_message>/.exec(content)?.[1] ?? '';
  const cands = candidates(content);
  const out = (action: string, extra: object) =>
    JSON.stringify({ action, ref: '', changes: [], question: '', answer: '', hours: [], ...extra });

  const qa = /Q:\s*(.+?)\s*A:\s*(.+)$/is.exec(msg);
  if (qa) return out('add_faq', { question: qa[1]!.trim(), answer: qa[2]!.trim() });

  const h = hours(msg);
  if (h && /\b(open|opening|close|hours?)\b|营业|开门|休息/i.test(msg))
    return out('edit_hours', { hours: h });

  const price =
    /(?:\$|S\$)\s*(\d{1,7}(?:\.\d{1,2})?)|(\d{1,7}(?:\.\d{1,2})?)\s*(?:dollars|块|元)/i.exec(msg);
  if (price) {
    const c =
      best(msg, cands, ['product', 'promotion']) ?? cands.find((x) => x.type === 'product') ?? null;
    if (!c) return none();
    return out('edit_fact', {
      ref: c.ref,
      changes: [{ field: 'price', value: Number(price[1] ?? price[2]).toFixed(2) }],
    });
  }

  const until = endDate(msg);
  if (until) {
    const c = best(msg, cands, ['promotion']) ?? cands.find((x) => x.type === 'promotion');
    return c
      ? out('edit_fact', { ref: c.ref, changes: [{ field: 'valid_until', value: until }] })
      : none();
  }

  const said =
    /(?:should (?:be|say)|actually|now)[:,]?\s+(.+)$/i.exec(msg)?.[1] ??
    /(?:应该是|改成)[:：]?\s*(.+)$/.exec(msg)?.[1];
  if (said) {
    const c = best(msg, cands, ['faq', 'policy']);
    if (!c) return none();
    return out('edit_fact', {
      ref: c.ref,
      changes: [{ field: c.type === 'faq' ? 'answer' : 'details', value: said.trim() }],
    });
  }
  return none();
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
