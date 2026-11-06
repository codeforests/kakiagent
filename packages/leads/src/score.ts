import type { LeadScore, Qualification, ScoreReason } from '@kaki/contracts';

/**
 * Lead scoring (LED-03; FEAT-050 §5.1, D2): fixed points per signal, fixed bands, owner-set
 * keywords and minimum budget. Pure code; no model is involved (ADR-008, ADR-025).
 */
export interface ScoreInput {
  need: string | null;
  budget: string | null;
  preferredTime: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  /** An AI turn in the contact's conversations had `request_commitment`. */
  wantsToOrder: boolean;
  /** `captures > 1` or the contact has more than one conversation. */
  returning: boolean;
}

export interface Scored {
  score: LeadScore;
  points: number;
  reasons: ScoreReason[];
}

/** Hot ≥ 5, warm 3–4, cold ≤ 2 (D2). */
export function bandOf(points: number): LeadScore {
  return points >= 5 ? 'hot' : points >= 3 ? 'warm' : 'cold';
}

/** Case-folded, NFKC, trimmed: how keywords are stored and matched. */
export const foldKeyword = (s: string) => s.normalize('NFKC').trim().toLowerCase();

const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first keyword found in `text`: CJK keywords by substring, others on word boundaries,
 * so "event" matches "an event" but not "prevent".
 */
export function matchKeyword(text: string | null, keywords: readonly string[]): string | null {
  if (!text) return null;
  const t = foldKeyword(text);
  for (const raw of keywords) {
    const k = foldKeyword(raw);
    if (!k) continue;
    if (HAN.test(k)) {
      if (t.includes(k)) return raw;
    } else if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(k)}(?![\\p{L}\\p{N}])`, 'u').test(t))
      return raw;
  }
  return null;
}

/**
 * The largest amount in a free-text budget, in whole S$: digits with `,` thousands or a `.`
 * decimal, optional `S$`/`$`/`SGD`, `k` ×1,000, `万` ×10,000. Nothing parseable → null.
 */
export function parseBudget(text: string | null): number | null {
  if (!text) return null;
  const t = text.normalize('NFKC');
  let best: number | null = null;
  for (const m of t.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|K|千|万|萬)?/gu)) {
    let n = Number(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    const unit = m[3];
    if (unit === 'k' || unit === 'K' || unit === '千') n *= 1_000;
    else if (unit === '万' || unit === '萬') n *= 10_000;
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best === null ? null : Math.round(best);
}

const filled = (s: string | null) => !!s && s.trim().length > 0;

/** The score, its points and the reasons in the order of the design's table (§5.1). */
export function scoreLead(input: ScoreInput, q: Qualification): Scored {
  const reasons: ScoreReason[] = [];
  const keyword = matchKeyword(input.need, q.keywords);
  if (keyword) reasons.push({ code: 'keyword', points: 2, detail: keyword.slice(0, 80) });
  if (q.minBudget !== null) {
    const amount = parseBudget(input.budget);
    if (amount !== null)
      reasons.push(
        amount >= q.minBudget
          ? { code: 'budget_met', points: 2, detail: String(q.minBudget) }
          : { code: 'budget_below', points: 0, detail: String(q.minBudget) },
      );
  }
  if (input.wantsToOrder) reasons.push({ code: 'wants_to_order', points: 2, detail: null });
  if (input.hasPhone && input.hasEmail)
    reasons.push({ code: 'both_contacts', points: 1, detail: null });
  if (filled(input.need)) reasons.push({ code: 'need_given', points: 1, detail: null });
  if (filled(input.preferredTime)) reasons.push({ code: 'timing_given', points: 1, detail: null });
  if (input.returning) reasons.push({ code: 'returning', points: 1, detail: null });
  const points = reasons.reduce((s, r) => s + r.points, 0);
  return { score: bandOf(points), points, reasons };
}
