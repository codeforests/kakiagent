/**
 * The deterministic verifier (ADR-008 decision 2): every protected value in a rendered
 * segment must come from a slot rendering. Plain code, no I/O.
 */

export type ViolationKind =
  | 'currency'
  | 'percentage'
  | 'date'
  | 'time'
  | 'duration'
  | 'stock'
  | 'price_number'
  | 'policy'
  | 'slot_syntax'
  | 'unknown_fact'
  | 'unknown_field';

export interface Violation {
  kind: ViolationKind;
  text: string;
}

export type VerifyResult = { ok: true } | { ok: false; violations: Violation[] };

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)`;
const WORDS = String.raw`${WORD}(?:[\s-]+(?:and\s+)?${WORD})*`;
const ZH_NUM = '[一二两三四五六七八九十百千]+';
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const UNIT = String.raw`(?:working\s+|business\s+)?(?:days?|weeks?|hours?|hrs?|minutes?|mins?|months?|years?|yrs?)`;

/** Currency codes and words, written before or after the amount. */
const CODES = '(?:sgd|usd|myr|rm|eur|gbp|aud|rmb|cny)';
const CUR_WORD = String.raw`(?:dollars?|bucks|cents?|ringgit|euros?|pounds?|yuan)`;
const CUR_QUAL = String.raw`(?:singapore|sing|us|s|aussie)`;
/** Between a price word and its number: "price is", "Price:", "price - ", "goes for around". */
const PRICE_GAP = String.raw`\s*[:=\-–—]?\s*(?:(?:is|are|of|about|around|roughly|approximately|only|just)\s+)*`;
/** A number that counts things, not money: "for 2 to 3 people". */
const QUANTITY = String.raw`\s*(?:(?:to|-|–)\s*\d+\s*)?(?:people|pax|persons?|guests?|pieces?|pcs|slices?|servings?|kg|g|grams?|cm|inch(?:es)?|layers?|tiers?|cupcakes?|cakes?|boxes|box)\b`;

const PATTERNS: [ViolationKind, RegExp][] = [
  ['currency', new RegExp(String.raw`(?:S\$|US\$|\b${CODES}|[$€£¥₹])\s*${NUM}`, 'giu')],
  [
    'currency',
    new RegExp(String.raw`${NUM}\s*(?:${CUR_QUAL}\s+)?(?:${CODES}\b|${CUR_WORD}|元|块|蚊)`, 'giu'),
  ],
  ['currency', new RegExp(String.raw`\b${WORDS}\s+(?:${CUR_QUAL}\s+)?${CUR_WORD}\b`, 'giu')],
  ['currency', new RegExp(`${ZH_NUM}\\s?(?:元|块)`, 'gu')],
  ['percentage', new RegExp(String.raw`${NUM}\s?(?:%|percent\b|per\s+cent\b)`, 'giu')],
  ['percentage', new RegExp(String.raw`\b${WORDS}\s+(?:percent|per\s+cent)\b`, 'giu')],
  ['percentage', /百分之/gu],
  ['date', /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/giu],
  ['date', new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?![a-z])`, 'giu')],
  ['date', new RegExp(String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b`, 'giu')],
  ['date', new RegExp(`(?:\\d+|${ZH_NUM})月(?:\\d+|${ZH_NUM})[日号]`, 'gu')],
  ['time', /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/giu],
  ['time', /\b\d{1,2}:\d{2}\b/gu],
  ['time', new RegExp(`(?:\\d+|${ZH_NUM})点(?:半|(?:\\d+|${ZH_NUM})分)?`, 'gu')],
  [
    'duration',
    new RegExp(
      String.raw`\b(?:${NUM}|${WORDS})(?:\s*(?:-|to)\s*(?:${NUM}|${WORDS}))?\s*${UNIT}\b`,
      'giu',
    ),
  ],
  ['duration', new RegExp(`(?:\\d+|${ZH_NUM})\\s?(?:个)?(?:天|小时|周|星期|月|年|分钟)`, 'gu')],
  [
    'stock',
    new RegExp(
      String.raw`\b(?:${NUM}|${WORDS})\s+(?:left|remaining|in\s+stock|available|pcs|pieces|units)\b`,
      'giu',
    ),
  ],
  ['stock', /\b(?:in\s+stock|out\s+of\s+stock|sold\s+out)\b|有货|没货|缺货|售罄/giu],
  [
    'price_number',
    new RegExp(
      String.raw`\b(?:prices?|priced|costs?|charges?|fees?|only|just|at|for)${PRICE_GAP}${NUM}(?!\d|[.,]\d|${QUANTITY})`,
      'giu',
    ),
  ],
  [
    'price_number',
    new RegExp(
      String.raw`\b(?:prices?|priced|costs?|charges?|fees?)${PRICE_GAP}${WORDS}\b(?!${QUANTITY}|\s+(?:${CUR_QUAL}\s+)?${CUR_WORD})`,
      'giu',
    ),
  ],
  [
    'policy',
    /\b(?:refunds?|refundable|deliver(?:y|ed)?\s+by|guarantee[sd]?|warrant(?:y|ies)|money[\s-]back)\b|退款|退货|保证|保修/giu,
  ],
  ['slot_syntax', /\[\[|\]\]/gu],
];

/**
 * Kinds a visitor's own literal number may justify: plain quantities only (FEAT-022
 * D3). A number after a price word is a price, so "is it 20?" never justifies
 * "the price is 20".
 */
const VISITOR_LITERAL_KINDS = new Set<ViolationKind>(['stock']);

const MASK = '';

export function verifySegment(
  text: string,
  spans: [number, number][],
  visitorTexts: string[],
): VerifyResult {
  // Slot renderings are protected: mask them so only model-typed text is scanned.
  const chars = [...text];
  let masked = '';
  let pos = 0;
  for (const ch of chars) {
    const inSpan = spans.some(([s, e]) => pos >= s && pos < e);
    masked += inSpan ? MASK : ch;
    pos += ch.length;
  }
  // Full-width digits and signs (５０, ＄) read as their ASCII forms.
  masked = masked.normalize('NFKC');
  const visitor = visitorTexts.join('\n').normalize('NFKC');
  const violations: Violation[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of masked.matchAll(re)) {
      const hit = m[0];
      if (VISITOR_LITERAL_KINDS.has(kind)) {
        const nums = hit.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
        if (
          nums.length &&
          nums.every((n) => new RegExp(`(?<![\\d.])${escape(n)}(?![\\d])`).test(visitor))
        )
          continue;
      }
      violations.push({ kind, text: hit });
    }
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
