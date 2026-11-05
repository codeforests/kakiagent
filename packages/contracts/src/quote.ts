/**
 * Quote arithmetic without Zod (FEAT-055 §5.1, D2): the approvals module, the dashboard's
 * draft editor and the widget's quote card compute the same totals, in integer cents, and
 * the panel chunk stays within its budget (ADR-016). `@kaki/contracts/quote`.
 */

export type GstNote = 'inclusive' | 'exclusive' | 'none';

export interface QuoteLine {
  quantity: number;
  unitPriceCents: number;
}

export interface QuoteTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  gst: GstNote;
}

/** `S$1,234.50` (NFR-10, design.md §6); a negative amount gets a leading `-`. */
export function formatSgd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}S$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${rest}`;
}

/**
 * Subtotal = sum of quantity x unit price; discount = subtotal x pct / 100, rounded half up
 * to the cent; total = subtotal - discount. No lines: all zero.
 */
export function totalsOf(
  terms: { lines: readonly QuoteLine[]; discountPct: number },
  gst: GstNote,
): QuoteTotals {
  const subtotalCents = terms.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const discountCents = Math.floor((subtotalCents * terms.discountPct + 50) / 100);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents, gst };
}
