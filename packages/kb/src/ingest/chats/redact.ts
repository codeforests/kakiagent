import { findPii, piiMask } from '@kaki/platform';

export interface RedactionCounts {
  names: number;
  phones: number;
  emails: number;
  ids: number;
  addresses: number;
}

export const NO_REDACTIONS: RedactionCounts = {
  names: 0,
  phones: 0,
  emails: 0,
  ids: 0,
  addresses: 0,
};

/** The tokens redaction leaves, and the masks of `piiMask` (ADR-015). */
export const REDACTED = /\[(?:name|phone|email|address)\]|\[(?:NRIC|CARD|BANK) /;

const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** International (`+44 20 7946 0958`) or Singapore (`9123 4567`, `+65 6123-4567`) numbers. */
const PHONE = /(?<![\w+])(?:\+\d[\d .-]{5,18}\d|(?:\+?65[ -]?)?[3689]\d{3}[ -]?\d{4})(?![\w])/g;
const ADDRESS = [
  /#\s?\d{1,3}\s?-\s?\d{1,5}[A-Z]?\b/g, // unit number #05-12
  /\b(?:Blk|Block)\s?\d{1,4}[A-Z]?\b/gi,
  /\b(?:Singapore|S)\s?\(?\d{6}\)?(?!\d)/g, // postal code after "Singapore" or "S"
];
const USERNAME = /(?<![\w@])@[A-Za-z][\w]{3,31}\b/g;
const CJK = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s: string) =>
  s
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}'’-]+/u)
    .filter(Boolean);

/**
 * The redactor for one export (FEAT-017 §5.3 step 5, ADR-015, D7): e-mails, phone numbers,
 * NRIC/card/bank numbers (`piiMask`), addresses, then the customers' names (each whole
 * name, and each word of 3 or more letters of a Latin name, as whole words) and
 * `@usernames`. Words that are part of the business's own names are kept, so a customer
 * called "Kaki Lim" doesn't redact "Kaki Bakery". Counts every replacement.
 */
export function createRedactor(customerNames: string[], businessNames: string[]) {
  const keep = new Set(businessNames.flatMap((n) => words(n.toLowerCase())));
  const targets = new Set<string>();
  for (const name of customerNames) {
    const n = name.normalize('NFKC').trim();
    if (!n) continue;
    if (CJK.test(n)) {
      if ([...n].length >= 2) targets.add(n);
      continue;
    }
    if (n.length >= 3 && !keep.has(n.toLowerCase())) targets.add(n);
    for (const w of words(n)) if ([...w].length >= 3 && !keep.has(w.toLowerCase())) targets.add(w);
  }
  // Longest first, so "Mdm Tan" goes before "Tan".
  const sorted = [...targets].sort((a, b) => b.length - a.length);
  const names = sorted.length
    ? new RegExp(
        sorted
          .map((t) =>
            CJK.test(t) ? escape(t) : `(?<![\\p{L}\\p{N}])${escape(t)}(?![\\p{L}\\p{N}])`,
          )
          .join('|'),
        'giu',
      )
    : null;

  return function redact(text: string, counts: RedactionCounts): string {
    let out = text.normalize('NFKC');
    out = out.replace(EMAIL, () => (counts.emails++, '[email]'));
    out = out.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      if (m.startsWith('+') && (digits < 7 || digits > 15)) return m;
      counts.phones++;
      return '[phone]';
    });
    const ids = findPii(out).length;
    if (ids) {
      counts.ids += ids;
      out = piiMask(out);
    }
    for (const re of ADDRESS) out = out.replace(re, () => (counts.addresses++, '[address]'));
    if (names) out = out.replace(names, () => (counts.names++, '[name]'));
    out = out.replace(USERNAME, () => (counts.names++, '[name]'));
    return out;
  };
}
