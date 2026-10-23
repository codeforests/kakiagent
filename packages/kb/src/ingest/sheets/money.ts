/** Prices and stock counts in spreadsheet cells (FEAT-016 §5.5 rules 4–6). */

export type PriceParse =
  { ok: true; cents: number } | { ok: false; reason: 'bad_price' | 'not_sgd' };

/** Another currency's code or sign anywhere in the cell. */
const FOREIGN =
  /(?:^|[^a-z])(?:rm|myr|usd|us\$|hk\$|hkd|a\$|aud|rmb|cny|eur|gbp|jpy|idr|rp|thb|inr)(?![a-z])|[€£¥元₹฿]/i;
const SGD_MARK = /^(?:sgd|s\$|\$)|(?:sgd|s\$|\$)$/gi;
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** Up to S$9,999,999.99 (the contracts' `Money`). */
const MAX_CENTS = 999_999_999;

/**
 * An SGD price in cents: an optional `S$`, `SGD` or `$` before or after, spaces,
 * thousands commas and up to two decimals; an XLSX number with float noise is rounded
 * when within a ten-thousandth of a cent. Other currencies are `not_sgd`; ranges, words
 * and negative amounts `bad_price`.
 */
export function parsePrice(raw: string): PriceParse {
  if (FOREIGN.test(raw)) return { ok: false, reason: 'not_sgd' };
  const s = raw.replace(/\s+/g, '').replace(SGD_MARK, '');
  if (!AMOUNT.test(s)) return { ok: false, reason: 'bad_price' };
  const cents = Number(s.replace(/,/g, '')) * 100;
  const rounded = Math.round(cents);
  if (Math.abs(cents - rounded) > 1e-4 || rounded > MAX_CENTS)
    return { ok: false, reason: 'bad_price' };
  return { ok: true, cents: rounded };
}

/** Whether a cell reads as a price, in any currency (header detection, suggestions). */
export const looksLikePrice = (raw: string) =>
  raw !== '' && (parsePrice(raw).ok || (FOREIGN.test(raw) && /\d/.test(raw)));

/** Whether a cell names a currency (a price, not a count). */
export const hasCurrency = (raw: string) => /\$|sgd/i.test(raw) || FOREIGN.test(raw);

/** A whole number of items ≥ 0: `12`, `12.0`, `1,200`; null when it isn't one. */
export function parseStock(raw: string): number | null {
  const s = raw.replace(/\s+/g, '');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.0+)?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

/** Cents as the contracts' `Money`, "38.00". */
export const centsText = (cents: number) => (cents / 100).toFixed(2);
