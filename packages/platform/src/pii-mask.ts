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

/** Full-width forms (U+FF01–U+FF5E) to ASCII: one UTF-16 unit each, so offsets hold. */
function fold(text: string): string {
  return text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

const NRIC_RE = /(?<![A-Za-z0-9])([STFGM])[ -]?((?:\d[ -]?){6}\d)[ -]?([A-Z])(?![A-Za-z0-9])/gi;
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

/** Digit groups joined by single spaces or hyphens, not inside a longer letter or digit run. */
const RUN_RE = /(?<![A-Za-z0-9])\d+(?:[ -]\d+)*(?![A-Za-z0-9])/g;

function digitRuns(folded: string): Group[][] {
  const runs: Group[][] = [];
  for (const m of folded.matchAll(RUN_RE)) {
    const groups: Group[] = [];
    for (const g of m[0].matchAll(/\d+/g)) {
      const start = m.index + g.index;
      groups.push({ start, end: start + g[0].length, digits: g[0] });
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
  const windows: { i: number; j: number; rank: number }[] = [];
  for (let i = 0; i < groups.length; i++) {
    let digits = '';
    for (let j = i; j < groups.length; j++) {
      digits += groups[j]!.digits;
      if (digits.length > 19) break;
      const rank = CARD_LENGTH_RANK.indexOf(digits.length);
      if (rank >= 0 && luhnOk(digits)) windows.push({ i, j, rank });
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

/** ADR-015 decision 1 keywords, plus bank names and transfer words visitors use (D4). */
const BANK_KEYWORD_EN =
  /(?<![A-Za-z])(?:accounts?|acct|acc|a\/c|bank|savings|current|paynow|dbs|posb|ocbc|uob|maybank|hsbc|citi|citibank|standard chartered|scb)(?![A-Za-z])/i;
const BANK_KEYWORD_ZH = /户口|账号|帐号|账户|帐户|银行|转账|转帐|存折/;
const BANK_WINDOW = 40;

function nearBankKeyword(folded: string, start: number, end: number): boolean {
  const around =
    folded.slice(Math.max(0, start - BANK_WINDOW), start) +
    ' ' +
    folded.slice(end, end + BANK_WINDOW);
  return BANK_KEYWORD_EN.test(around) || BANK_KEYWORD_ZH.test(around);
}

const overlaps = (a: { start: number; end: number }, found: PiiFinding[]) =>
  found.some((f) => a.start < f.end && f.start < a.end);

/** Every NRIC/FIN, card and bank account number in the text, in order, non-overlapping. */
export function findPii(text: string): PiiFinding[] {
  const folded = fold(text);
  const found: PiiFinding[] = [];

  for (const m of folded.matchAll(NRIC_RE)) {
    if (nricChecksumOk(m[1]!, digitsOf(m[2]!), m[3]!))
      found.push({ kind: 'nric', start: m.index, end: m.index + m[0].length });
  }

  const runs = digitRuns(folded)
    .map((groups) => groups.filter((g) => !overlaps(g, found)))
    .filter((groups) => groups.length > 0);
  const cards: PiiFinding[] = [];
  for (const groups of runs) cardsIn(groups, cards);
  found.push(...cards.sort((a, b) => a.start - b.start));

  for (const groups of runs) {
    const span = { start: groups[0]!.start, end: groups[groups.length - 1]!.end };
    const len = groups.reduce((n, g) => n + g.digits.length, 0);
    if (len < 9 || len > 12 || overlaps(span, found)) continue;
    if (folded[span.start - 1] === '+') continue;
    if (nearBankKeyword(folded, span.start, span.end)) found.push({ kind: 'bank', ...span });
  }

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
  let out = text;
  for (const f of findPii(text).reverse())
    out = out.slice(0, f.start) + token(f.kind, text.slice(f.start, f.end)) + out.slice(f.end);
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SG_PHONE_RE = /(?<![A-Za-z0-9+])(?:\+?65[ -]?)?[3689]\d{3}[ -]?\d{4}(?![A-Za-z0-9])/g;

/** GOV-04 "mask other PII in logs": piiMask, then emails and SG phone numbers. */
export function maskLogText(text: string): string {
  return piiMask(text).replace(EMAIL_RE, '[EMAIL]').replace(SG_PHONE_RE, '[PHONE]');
}
