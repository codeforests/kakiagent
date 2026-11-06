import { formatSgd, totalsOf, type GstNote, type QuoteTotals } from '@kaki/contracts/quote';

/**
 * Quotes built in code (FEAT-055 §5.1, D2; ADR-008): lines come from this turn's retrieved
 * product facts matched to triage's `items`, totals are integer arithmetic, and the visitor's
 * text is a fixed template with the approver's values. No model writes any of it.
 */

export { formatSgd, totalsOf, type GstNote, type QuoteTotals };

/** A product fact as the turn retrieved it, with its visitor-facing price (KB-15). */
export interface PricedProduct {
  factId: string;
  version: number;
  name: string;
  unit: string | null;
  /** The price the visitor is quoted: GST-inclusive at a registered tenant. */
  priceCents: number;
  /** The fact's GST treatment as stored. */
  gst: 'inclusive' | 'exclusive' | 'unknown';
}

export interface Line {
  factId: string | null;
  factVersion: number | null;
  label: string;
  unit: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface Terms {
  lines: Line[];
  discountPct: number;
  note: string;
}

export type ApprovalKind = 'quote' | 'discount' | 'commitment';

/** What triage read from the request (`request_commitment` args), each string ≤ 200 chars. */
export interface CommitmentRequest {
  items?: string | undefined;
  quantity?: string | undefined;
  date?: string | undefined;
  discount?: string | number | undefined;
}

export const MAX_LINES = 3;
export const MAX_QUANTITY = 100_000;
const REQUEST_MAX = 200;

const HAN = /\p{Script=Han}/u;

/** A light English stem: "cupcakes" → "cupcake", "berries" → "berry", "boxes" → "box". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Match tokens: Latin words of 3+ letters (lower case, stemmed), and Han text by character
 * bigram (a single Han character stands alone).
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) out.add(stem(w));
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** The first whole number in the text, if it is 1–100 000. */
export function parseQuantity(text: string | undefined): number | null {
  const m = text?.replace(/,(?=\d{3})/g, '').match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= MAX_QUANTITY ? n : null;
}

/** A percentage asked for: a number, or "15%", "15 percent"; 0–100, else null. */
export function parseDiscount(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value.match(/\d+(\.\d+)?/)?.[0] ?? NaN);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

/**
 * The draft lines: the products whose name shares a token with `items`, best match first,
 * at most three, each at the requested quantity (1 when none or out of range).
 */
export function draftLines(
  items: string | undefined,
  quantity: string | undefined,
  products: readonly PricedProduct[],
): Line[] {
  if (!items) return [];
  const wanted = tokens(items);
  const qty = parseQuantity(quantity) ?? parseQuantity(items) ?? 1;
  return products
    .map((p, i) => {
      const have = tokens(p.name);
      let score = 0;
      for (const t of have) if (wanted.has(t)) score += HAN.test(t) ? 1 : 2;
      return { p, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_LINES)
    .map(({ p }) => ({
      factId: p.factId,
      factVersion: p.version,
      label: p.name.slice(0, 120),
      unit: p.unit,
      quantity: qty,
      unitPriceCents: p.priceCents,
    }));
}

/** `discount` when a percentage was asked; `quote` with a matched line or a quantity; else `commitment`. */
export function kindOf(
  request: CommitmentRequest,
  discountPct: number | null,
  lines: readonly Line[],
): ApprovalKind {
  if (discountPct !== null && discountPct > 0) return 'discount';
  if (lines.length > 0 || parseQuantity(request.quantity) !== null) return 'quote';
  return 'commitment';
}

/** Trims each request field to 200 characters; drops empty ones. */
export function cleanRequest(r: CommitmentRequest): {
  items: string | null;
  quantity: string | null;
  date: string | null;
} {
  const clean = (v: string | undefined) => {
    const t = v?.trim().replace(/\s+/g, ' ').slice(0, REQUEST_MAX);
    return t ? t : null;
  };
  return { items: clean(r.items), quantity: clean(r.quantity), date: clean(r.date) };
}

/** "200 × Vanilla cupcake · 15% off", "+2 more" for further lines; the request without lines. */
export function headline(terms: Terms, request: { items: string | null }): string {
  const [first, ...rest] = terms.lines;
  const parts: string[] = [];
  if (first)
    parts.push(`${first.quantity} × ${first.label}${rest.length ? ` +${rest.length} more` : ''}`);
  else parts.push(request.items ? request.items.slice(0, 80) : 'Custom request');
  if (terms.discountPct > 0) parts.push(`${terms.discountPct}% off`);
  return parts.join(' · ');
}

const GST_EN: Record<GstNote, string> = {
  inclusive: ' (incl. GST)',
  exclusive: ' (before GST)',
  none: '',
};
const GST_ZH: Record<GstNote, string> = {
  inclusive: '（含消费税）',
  exclusive: '（未含消费税）',
  none: '',
};

/**
 * The visitor's quote text (also the message body for non-widget channels), from the
 * approver's values only: "Here's your quote from {business}: …", then the staff note.
 */
export function quoteText(
  language: 'en' | 'zh',
  business: string,
  terms: Terms,
  totals: QuoteTotals,
): string {
  const zh = language === 'zh';
  const out: string[] = [
    zh ? `这是${business}给您的报价：` : `Here's your quote from ${business}:`,
  ];
  for (const l of terms.lines) {
    const amount = formatSgd(l.quantity * l.unitPriceCents);
    out.push(
      zh
        ? `${l.quantity} × ${l.label}，单价 ${formatSgd(l.unitPriceCents)} = ${amount}`
        : `${l.quantity} × ${l.label} at ${formatSgd(l.unitPriceCents)} = ${amount}`,
    );
  }
  if (terms.discountPct > 0)
    out.push(
      zh
        ? `优惠 ${terms.discountPct}%：${formatSgd(-totals.discountCents)}`
        : `${terms.discountPct}% off: ${formatSgd(-totals.discountCents)}`,
    );
  if (terms.lines.length > 0)
    out.push(
      zh
        ? `总计 ${formatSgd(totals.totalCents)}${GST_ZH[totals.gst]}`
        : `Total ${formatSgd(totals.totalCents)}${GST_EN[totals.gst]}`,
    );
  if (terms.note.trim()) out.push(terms.note.trim());
  return out.join('\n');
}

/** The visitor's notice when an approval is rejected (UC-22 5a). */
export const rejectedNotice = (language: 'en' | 'zh') =>
  language === 'zh'
    ? '我们的团队暂时无法确认这项请求，但会尽快跟进您。'
    : "Our team couldn't confirm this one, but they'll follow up with you.";

/** The visitor's notice when an approval expires (APR-06, UC-22 5d). */
export const expiredNotice = (language: 'en' | 'zh') =>
  language === 'zh'
    ? '抱歉让您久等了。我们的团队会就这项请求联系您。'
    : 'Sorry for the wait. Our team will contact you about this request.';
