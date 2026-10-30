import type { BoundaryRules } from '@kaki/approvals';
import type { Task, TurnPlan } from './plan.js';
import { asData } from './prompt.js';

/**
 * Boundary rules in the turn (APR-01; FEAT-054 §5.3). Blocked topics are refused in code:
 * a phrase match on the visitor's message is the floor, and triage's `out_of_scope`
 * `blocked` catches paraphrases and other languages (D2). Allowed topics only guide (D3).
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One word of a topic: its singular stem, then an optional plural ending. */
function wordPattern(word: string): string {
  const stem =
    word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  return `${escape(stem)}(?:s|es)?`;
}

const cache = new Map<string, RegExp | string>();

/** A whole-word, case-insensitive pattern for a topic; CJK topics match as a substring. */
function topicMatcher(topic: string): RegExp | string | null {
  const t = norm(topic).replace(/['’]/g, '');
  if (!t.trim()) return null;
  const hit = cache.get(t);
  if (hit) return hit;
  let m: RegExp | string;
  if (CJK.test(t)) m = t.replace(/\s+/g, '');
  else {
    const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) return null;
    m = new RegExp(
      `(?<![\\p{L}\\p{N}])${words.map(wordPattern).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`,
      'u',
    );
  }
  if (cache.size > 500) cache.clear();
  cache.set(t, m);
  return m;
}

/** The visitor's message names a blocked topic (whole words; a plural allowed; CJK substring). */
export function blockedTopicHit(
  rules: Pick<BoundaryRules, 'blockedTopics'>,
  text: string,
): boolean {
  if (!rules.blockedTopics.length) return false;
  const msg = norm(text).replace(/['’]/g, '');
  const compact = msg.replace(/\s+/g, '');
  return rules.blockedTopics.some((topic) => {
    const m = topicMatcher(topic);
    if (m === null) return false;
    return typeof m === 'string' ? compact.includes(m) : m.test(msg);
  });
}

const isBlocked = (t: Task) => t.kind === 'out_of_scope' && t.args.topic === 'blocked';

/**
 * After triage: when the message is about a blocked topic (phrase match, or triage said so),
 * its `answer` tasks become one `out_of_scope` `blocked` task, so no reply-model call answers
 * it. Other tasks (escalate, capture_lead, …) are kept in plan order.
 */
export function applyBoundary(
  plan: TurnPlan,
  rules: Pick<BoundaryRules, 'blockedTopics'>,
  text: string,
): { plan: TurnPlan; blocked: boolean } {
  const blocked = plan.tasks.some(isBlocked) || blockedTopicHit(rules, text);
  if (!blocked) return { plan, blocked: false };
  const tasks: Task[] = [];
  let placed = plan.tasks.some(isBlocked);
  for (const task of plan.tasks) {
    if (task.kind !== 'answer') tasks.push(task);
    else if (!placed) {
      tasks.push({ kind: 'out_of_scope', args: { topic: 'blocked' } });
      placed = true;
    }
  }
  if (!placed) tasks.push({ kind: 'out_of_scope', args: { topic: 'blocked' } });
  return { plan: { ...plan, tasks: tasks.slice(0, 6) }, blocked: true };
}

export const TRIAGE_TOPICS_HANDLED = 'Topics this business handles: ';
export const TRIAGE_TOPICS_BLOCKED = "Topics it doesn't discuss: ";

/**
 * Triage's uncached tail with the tenant's topics (D2), as JSON arrays of data. None when
 * both lists are empty, so a tenant without topics sends the same request as before.
 */
export function triageTail(
  rules: Pick<BoundaryRules, 'allowedTopics' | 'blockedTopics'>,
): string | undefined {
  const lines = [
    ...(rules.allowedTopics.length
      ? [TRIAGE_TOPICS_HANDLED + JSON.stringify(rules.allowedTopics.map(asData))]
      : []),
    ...(rules.blockedTopics.length
      ? [TRIAGE_TOPICS_BLOCKED + JSON.stringify(rules.blockedTopics.map(asData))]
      : []),
  ];
  return lines.length ? lines.join('\n') : undefined;
}
