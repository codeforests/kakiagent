/**
 * Edge PII masking (ADR-015 decision 1, GOV-04): NRIC/FIN numbers (checksum-validated),
 * payment card numbers (Luhn-validated) and Singapore bank account numbers (next to an
 * account or bank keyword) become typed tokens such as `[NRIC ••••567D]`. The original
 * value is kept nowhere. Pure and dependency-free, so the gateway can import it through
 * `@kaki/platform/pii-mask` without the platform's clients (FEAT-003 §3.1, D3).
 */

export type PiiKind = 'nric' | 'card' | 'bank';

/** A match, as UTF-16 offsets into the input. */
export interface PiiFinding {
  kind: PiiKind;
  start: number;
  end: number;
}

const DOTS = '••••';

/**
 * Matching runs on a folded copy: full-width forms (U+FF01–U+FF5E) become ASCII, other
 * spaces (every Unicode space separator, tab, line breaks, zero-width space) a space, and
 * dashes (U+2010–U+2015, U+2212, U+FE58, U+FE63, soft hyphen) a hyphen. Every mapping is
 * one UTF-16 unit to one, so offsets hold (DD-1, D10).
 */
function fold(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\p{Zs}\t\n\r\u200B]/gu, ' ')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\u00AD]/g, '-');
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Between groups: one or two spaces, or a hyphen with an optional space either side. */
const SEP = '(?: {1,2}| ?- ?)';
const NRIC_RE = new RegExp(
  `(?<!\\d)([STFGM])(${SEP}?)((?:\\d${SEP}?){6}\\d)(${SEP}?)([A-Z])(?!\\d)`,
  'gi',
);
const NRIC_WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
const NRIC_LETTERS: Record<string, string> = {
  S: 'JZIHGFEDCBA',
  T: 'JZIHGFEDCBA',
  F: 'XWUTRQPNMLK',
  G: 'XWUTRQPNMLK',
  M: 'XWUTRQPNJLK',
};
const NRIC_OFFSET: Record<string, number> = { S: 0, T: 4, F: 0, G: 4, M: 3 };

export function nricChecksumOk(prefix: string, digits: string, letter: string): boolean {
  const p = prefix.toUpperCase();
  if (!(p in NRIC_LETTERS) || !/^\d{7}$/.test(digits)) return false;
  let sum = NRIC_OFFSET[p]!;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * NRIC_WEIGHTS[i]!;
  return NRIC_LETTERS[p]![sum % 11] === letter.toUpperCase();
}

export function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

interface Group {
  start: number;
  end: number;
  digits: string;
}

/**
 * Digit groups joined by separators. Letters may touch a run (`…4242pls`, M2); digits
 * can't, by construction. `spaced` marks a group that follows a space-only separator.
 */
const RUN_RE = new RegExp(`\\d+(?:${SEP}\\d+)*`, 'g');

interface RunGroup extends Group {
  spaced: boolean;
}

function digitRuns(folded: string): RunGroup[][] {
  const runs: RunGroup[][] = [];
  for (const m of folded.matchAll(RUN_RE)) {
    const groups: RunGroup[] = [];
    let prevEnd = -1;
    for (const g of m[0].matchAll(/\d+/g)) {
      const start = m.index + g.index;
      const spaced = prevEnd >= 0 && !folded.slice(prevEnd, start).includes('-');
      groups.push({ start, end: start + g[0].length, digits: g[0], spaced });
      prevEnd = start + g[0].length;
    }
    runs.push(groups);
  }
  return runs;
}

/** Card lengths, most common first: a stray digit next to a card shouldn't win (D9). */
const CARD_LENGTH_RANK = [16, 15, 19, 14, 13, 17, 18];

/**
 * Windows of consecutive groups with 13–19 digits that pass Luhn, taken best first (by
 * `CARD_LENGTH_RANK`, then earliest) where they don't share a group with one already
 * taken. A window never holds more than 19 digits, so finding them is linear in the run
 * and the whole search is bounded (AC-10).
 */
function cardsIn(groups: Group[], out: PiiFinding[]): void {
  // The run's digits as numbers, and where each group starts in them: no strings built
  // per window, so a 4000-character run of digits stays cheap (AC-10).
  const digits: number[] = [];
  const from: number[] = [];
  for (const g of groups) {
    from.push(digits.length);
    for (let k = 0; k < g.digits.length; k++) digits.push(g.digits.charCodeAt(k) - 48);
  }
  from.push(digits.length);
  const windows: { i: number; j: number; rank: number }[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i; j < groups.length; j++) {
      const len = from[j + 1]! - from[i]!;
      if (len > 19) break;
      const rank = CARD_LENGTH_RANK.indexOf(len);
      if (
        rank >= 0 &&
        cardPrefixOk(digits[from[i]!]!, len) &&
        luhnRange(digits, from[i]!, from[j + 1]!)
      )
        windows.push({ i, j, rank });
    }
  }
  windows.sort((a, b) => a.rank - b.rank || a.i - b.i);
  const used = new Uint8Array(groups.length);
  for (const w of windows) {
    if (used.subarray(w.i, w.j + 1).some((u) => u === 1)) continue;
    used.fill(1, w.i, w.j + 1);
    out.push({ kind: 'card', start: groups[w.i]!.start, end: groups[w.j]!.end });
  }
}

/**
 * Issued card numbers start with 2–6 (Mastercard 2 and 5, Amex 3, Visa 4, Discover and
 * UnionPay 6), and only Visa issued 13 digits. A timestamp or order number starting
 * with 1, 7, 8, 9 or 0 is not a card, even when it passes Luhn (D13).
 */
export function cardPrefixOk(first: number, len: number): boolean {
  return len === 13 ? first === 4 : first >= 2 && first <= 6;
}

function luhnRange(digits: number[], start: number, end: number): boolean {
  let sum = 0;
  for (let k = end - 1, i = 0; k >= start; k--, i++) {
    let d = digits[k]!;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** ADR-015 decision 1 keywords, plus bank names and transfer words visitors use (D4). */
const BANK_KEYWORD_EN =
  /(?<![A-Za-z])(?:accounts?|acct|acc|a\/c|bank|savings|current|paynow|dbs|posb|ocbc|uob|maybank|hsbc|citi|citibank|standard chartered|scb)(?![A-Za-z])/gi;
const BANK_KEYWORD_ZH = /户口|账号|帐号|账户|帐户|银行|转账|转帐|存折/g;
const BANK_WINDOW = 40;

/** Where the bank keywords are, as [start, end) spans, found once per text. */
function bankKeywordSpans(folded: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const re of [BANK_KEYWORD_EN, BANK_KEYWORD_ZH])
    for (const m of folded.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  return spans.sort((a, b) => a[0] - b[0]);
}

const nearBankKeyword = (spans: [number, number][], start: number, end: number) =>
  spans.some(([s, e]) =>
    e <= start ? start - e <= BANK_WINDOW : s >= end && s - end < BANK_WINDOW,
  );

const overlaps = (a: { start: number; end: number }, found: PiiFinding[]) =>
  found.some((f) => a.start < f.end && f.start < a.end);

const isLetter = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);

/** A bank number glued to a word (`UEN 201912345K`, `INV-2026-10-0001`) is a code (D15). */
const gluedToWord = (folded: string, start: number, end: number) =>
  isLetter(folded[end]) ||
  isLetter(folded[start - 1]) ||
  (folded[start - 1] === '-' && isLetter(folded[start - 2]));

/**
 * Bank numbers (D4, D15): a run is split at space-only separators into chunks. A chunk of
 * 9 or more digits, or one written with hyphens, is a number on its own. Shorter chunks
 * are groups typed with spaces (`123 456789 0`), so from the earliest such chunk the
 * longest window of 9–12 digits is taken whole. Either kind must sit next to a keyword.
 */
function banksIn(
  folded: string,
  keywords: [number, number][],
  groups: RunGroup[],
  found: PiiFinding[],
): void {
  if (groups.reduce((n, g) => n + g.digits.length, 0) < 9) return;
  const runStart = groups[0]!.start;
  const runEnd = groups[groups.length - 1]!.end;
  const near: [number, number][] = [];
  // `keywords` is sorted by start, and so by end: skip to the first that can be near.
  let lo = 0;
  let hi = keywords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keywords[mid]![1] < runStart - BANK_WINDOW) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < keywords.length && keywords[k]![0] < runEnd + BANK_WINDOW; k++)
    near.push(keywords[k]!);
  if (near.length === 0) return;
  const chunks: (Group & { whole: boolean })[] = [];
  for (const g of groups) {
    const last = chunks[chunks.length - 1];
    if (last && !g.spaced)
      chunks[chunks.length - 1] = {
        start: last.start,
        end: g.end,
        digits: last.digits + g.digits,
        whole: true,
      };
    else chunks.push({ start: g.start, end: g.end, digits: g.digits, whole: g.digits.length >= 9 });
  }
  const take = (start: number, end: number) => {
    const w = { start, end };
    if (overlaps(w, found) || folded[start - 1] === '+' || gluedToWord(folded, start, end))
      return false;
    if (!nearBankKeyword(near, start, end)) return false;
    found.push({ kind: 'bank', start, end });
    return true;
  };
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (c.whole) {
      if (c.digits.length >= 9 && c.digits.length <= 12) take(c.start, c.end);
      continue;
    }
    let len = 0;
    let last = -1;
    for (let j = i; j < chunks.length && !chunks[j]!.whole; j++) {
      len += chunks[j]!.digits.length;
      if (len > 12) break;
      if (len >= 9) last = j;
    }
    if (last >= 0 && take(c.start, chunks[last]!.end)) i = last;
  }
}

/** Every NRIC/FIN, card and bank account number in the text, in order, non-overlapping. */
export function findPii(text: string): PiiFinding[] {
  const folded = fold(text);
  const found: PiiFinding[] = [];

  for (const m of folded.matchAll(NRIC_RE)) {
    const [whole, prefix, sepAfterPrefix, digits, sepBeforeLetter, letter] =
      m as unknown as string[];
    const end = m.index + whole!.length;
    // Glued to a word (M2) only when written solid: "has 1234567 A" is not an NRIC.
    if (/[A-Za-z]/.test(folded[m.index - 1] ?? '') && sepAfterPrefix) continue;
    if (/[A-Za-z]/.test(folded[end] ?? '') && sepBeforeLetter) continue;
    if (nricChecksumOk(prefix!, digitsOf(digits!), letter!))
      found.push({ kind: 'nric', start: m.index, end });
  }

  const runs = digitRuns(folded)
    .map((groups) => groups.filter((g) => !overlaps(g, found)))
    .filter((groups) => groups.length > 0);
  const cards: PiiFinding[] = [];
  for (const groups of runs) cardsIn(groups, cards);
  found.push(...cards.sort((a, b) => a.start - b.start));

  const keywords = bankKeywordSpans(folded);
  if (keywords.length > 0) for (const groups of runs) banksIn(folded, keywords, groups, found);

  return found.sort((a, b) => a.start - b.start);
}

function token(kind: PiiKind, value: string): string {
  if (kind === 'nric') {
    const v = fold(value).replace(/[ -]/g, '').toUpperCase();
    return `[NRIC ${DOTS}${v.slice(-4)}]`;
  }
  const digits = digitsOf(fold(value));
  return `[${kind === 'card' ? 'CARD' : 'BANK'} ${DOTS}${digits.slice(-4)}]`;
}

/** GOV-04: the text with every finding replaced by its token. Idempotent. */
export function piiMask(text: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const f of findPii(text)) {
    parts.push(text.slice(at, f.start), token(f.kind, text.slice(f.start, f.end)));
    at = f.end;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

// The lookbehind starts a match only at the start of a local part, so the scan is linear (M3).
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SG_PHONE_RE = /(?<![0-9+])(?:\+?65[ -]?)?[3689]\d{3}[ -]?\d{4}(?!\d)/g;

/** GOV-04 "mask other PII in logs": piiMask, then emails and SG phone numbers. */
export function maskLogText(text: string): string {
  return replaceOnFolded(piiMask(text).replace(EMAIL_RE, '[EMAIL]'), SG_PHONE_RE, '[PHONE]');
}

/** Replaces matches found on the folded text in the original, in one pass (M4). */
function replaceOnFolded(text: string, re: RegExp, by: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const m of fold(text).matchAll(re)) {
    parts.push(text.slice(at, m.index), by);
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return parts.join('');
}
