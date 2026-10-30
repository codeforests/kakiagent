import type { BoundaryRules } from '@kaki/approvals';
import type { Task, TurnPlan } from './plan.js';
import { asData } from './prompt.js';
import type { Violation } from './verify.js';

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

/**
 * The reply-side segment check (FEAT-054 §5.3, D4, D5; ADR-008 decision 3): model-typed
 * text must not offer a discount or make a commitment the business forbids. Run after the
 * leak guard on the same text, slot renderings masked, so the business's own policy text
 * ("full refund", "delivery fee") never trips it. Rules, not a classifier.
 */
const NOT = String.raw`(?<!\b(?:not|never|cannot|can't|can not|don't|do not|won't|unable to|no)\s+)`;

/** Offers, not the word: "we don't offer discounts" passes. Always on until FEAT-055 (D4). */
const DISCOUNT_OFFER: RegExp[] = [
  /\b(?:we|i)\s*(?:can|could|will|'ll|would)\s+(?:give|offer|do|provide|arrange|apply)\s+(?:you\s+)?(?:a\s+|an\s+|some\s+)?(?:\w+\s+)?(?:discount|special price|cheaper price|promo)/u,
  /\b(?:discount|promo)\s+(?:for you|is possible|can be arranged)/u,
  /(?<!不)(?:给您|帮您|可以给您|可以)\s*(?:打.{0,2}折|优惠|折扣)/u,
];

const COMMITMENTS: Record<'delivery_guarantee' | 'refund', RegExp[]> = {
  delivery_guarantee: [
    new RegExp(
      String.raw`${NOT}\bguarantee[ds]?\b(?:\W+\w+){0,6}?\W+(?:deliver\w*|arriv\w*|reach\w*|on time)`,
      'u',
    ),
    new RegExp(
      String.raw`\b(?:deliver\w*|arriv\w*|on time)\b(?:\W+\w+){0,6}?\W+${NOT}guarantee[ds]?\b`,
      'u',
    ),
    /\b(?:will|'ll)\s+(?:definitely|surely|certainly)\s+(?:arrive|be delivered|reach)/u,
    /(?<!不|无法|不能)保证.{0,6}(?:送达|到)/u,
    /(?<!不)一定(?:会|能)?.{0,4}(?:送达|送到|到货)/u,
  ],
  refund: [
    /\b(?:we|i)\s*(?:can|will|'ll)\s+(?:give|offer|issue|process|arrange)\s+(?:you\s+)?(?:a\s+)?(?:full\s+)?refund/u,
    new RegExp(String.raw`${NOT}\bmoney[- ]back\b`, 'u'),
    /\brefund(?:ed)?\s+in\s+full\b/u,
    /(?<!不)(?:给您|可以|会)\s*退款/u,
  ],
};

export interface BoundaryGuard {
  check(text: string, spans: [number, number][]): Violation[];
}

/** Built once per reply from the rules in force; unticked keys aren't checked. */
export function boundaryGuard(
  rules: Pick<BoundaryRules, 'forbiddenCommitments' | 'customCommitments'>,
): BoundaryGuard {
  const commitments = [
    ...rules.forbiddenCommitments.flatMap((k) =>
      k === 'delivery_guarantee' || k === 'refund' ? COMMITMENTS[k] : [],
    ),
  ];
  const custom = rules.customCommitments;
  return {
    check(text, spans) {
      const typed = norm(maskSpans(text, spans)).replace(/’/g, "'");
      const found: Violation[] = [];
      for (const re of DISCOUNT_OFFER) {
        const m = re.exec(typed);
        if (m) {
          found.push({ kind: 'discount_offer', text: m[0] });
          break;
        }
      }
      for (const re of commitments) {
        const m = re.exec(typed);
        if (m) {
          found.push({ kind: 'commitment', text: m[0] });
          break;
        }
      }
      if (!found.some((v) => v.kind === 'commitment') && custom.length) {
        const hit = custom.find((phrase) => blockedTopicHit({ blockedTopics: [phrase] }, typed));
        if (hit) found.push({ kind: 'commitment', text: hit });
      }
      return found;
    },
  };
}

/** The segment without its slot renderings: only what the model typed (as `verifySegment`). */
function maskSpans(text: string, spans: [number, number][]): string {
  let out = '';
  let pos = 0;
  for (const ch of text) {
    out += spans.some(([s, e]) => pos >= s && pos < e) ? ' ' : ch;
    pos += ch.length;
  }
  return out;
}
