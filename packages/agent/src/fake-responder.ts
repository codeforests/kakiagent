import type { GenerateRequest } from '@kaki/llm-gateway';

/** Questions about opening hours, in English, Singlish and Chinese. */
const HOURS_Q = /\b(hours?|open|opening|close|closing)\b|营业|几点|开门|关门|周末/i;
const WEEKEND_Q = /\b(weekends?|saturday|sunday|sat|sun)\b|周末|星期六|星期天|星期日|周六|周日/i;

/**
 * What the fake model writes in local development and the E2E suite (plan §2, P10): a
 * slot-correct answer built from the first two facts in the prompt, or "I'll check".
 * It reads the fact lines that `factLine` writes into the tail, the reply language, and
 * (FEAT-023) answers an hours question with the hours slots, so it stays in this module.
 */
export function fakeVisitorResponder(req: GenerateRequest): string {
  const answer = answerOf(req);
  // FEAT-024: a friendly tenant that allows emoji gets one, so the setting shows locally.
  const system = req.system ?? '';
  const friendlyEmoji = /^Tone: friendly\b/m.test(system) && /^Emoji: allowed\b/m.test(system);
  return friendlyEmoji ? `${answer} 🙂` : answer;
}

const NAME_Q = /\b(who are you|what('s| is) your name)\b|你是谁|你叫什么/i;

/**
 * FEAT-054: a careless first draft for the boundary guard to block. Asked for a guarantee
 * or a special price, the fake promises it; told the draft was blocked, it defers to the
 * team, as a real model does after one regeneration.
 */
const PROMISE_Q = /\bguarantee\b|保证/i;
const SPECIAL_PRICE_Q = /\bspecial price\b|打折/i;
const BLOCKED_PROMISE =
  /^Your previous continuation was blocked .*(?:commitment|discount_offer) "/m;

function promiseOf(question: string, tail: string, zh: boolean): string | null {
  if (!PROMISE_Q.test(question) && !SPECIAL_PRICE_Q.test(question)) return null;
  if (BLOCKED_PROMISE.test(tail))
    return zh
      ? '我先跟团队确认一下，再回复您。'
      : "I'll check that with the team and get back to you.";
  if (PROMISE_Q.test(question))
    return zh ? '一定会准时送达！' : 'Yes, it will definitely arrive on time.';
  return zh ? '可以给您打折！' : 'Sure, we can give you a special price!';
}

function answerOf(req: GenerateRequest): string {
  const tail = req.tail ?? '';
  const zh = /^Reply language: Chinese/m.test(tail);
  const question =
    [...(req.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  const name = /^<assistant>\nName: (.+)$/m.exec(req.system ?? '')?.[1];
  if (name && NAME_Q.test(question))
    return zh
      ? `我是${name}，这里的 AI 助手。有什么可以帮您？`
      : `I'm ${name}, the AI assistant here. How can I help?`;
  const promise = promiseOf(question, tail, zh);
  if (promise) return promise;
  if (HOURS_Q.test(question) && /\[\[s:hours\.today\]\]/.test(tail))
    return hoursAnswer(question, tail, zh);
  const facts = [
    ...tail.matchAll(/^\[f:([0-9a-f]+)\] (product|faq|policy|promotion)\b(.*)$/gm),
  ].slice(0, 2);
  if (!facts.length)
    return zh
      ? '这个我不太确定，我先跟团队确认一下再回复您。'
      : "I'm not sure about that. Let me check with the team and get back to you.";
  const parts = facts.map(([, ref, type, rest = '']) => {
    const slot = (field: string) => `[[f:${ref}.${field}]]`;
    switch (type) {
      case 'faq':
        return slot('answer');
      case 'policy':
        return slot('details');
      case 'promotion': {
        const price = rest.includes('| price:') ? slot('price') : '';
        const until = rest.includes('| until:')
          ? zh
            ? `截至${slot('valid_until')}`
            : `until ${slot('valid_until')}`
          : '';
        const extra = [price, until].filter(Boolean).join(zh ? '，' : ', ');
        if (zh) return `${slot('title')}：${slot('details')}${extra ? `（${extra}）` : ''}`;
        return `${slot('title')}: ${slot('details')}${extra ? ` (${extra})` : ''}`;
      }
      default: {
        if (zh) {
          const unit = rest.includes('| unit:') ? `（${slot('unit')}）` : '';
          return `${slot('name')}${unit}的价格是${slot('price')}。`;
        }
        const unit = rest.includes('| unit:') ? ` (${slot('unit')})` : '';
        return `The ${slot('name')}${unit} is ${slot('price')}.`;
      }
    }
  });
  return parts.join(' ');
}

function hoursAnswer(question: string, tail: string, zh: boolean): string {
  const closed = /\[\[s:next_open\]\]/.test(tail);
  if (WEEKEND_Q.test(question))
    return zh
      ? '周六营业时间是[[s:hours.sat]]，周日是[[s:hours.sun]]。'
      : 'On Saturday we are open [[s:hours.sat]], and on Sunday [[s:hours.sun]].';
  const today = zh ? '今天的营业时间是[[s:hours.today]]。' : "Today's hours are [[s:hours.today]].";
  if (!closed) return today;
  return zh ? `${today}我们将于[[s:next_open]]再开门。` : `${today} We open again [[s:next_open]].`;
}
