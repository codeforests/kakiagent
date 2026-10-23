import { sameValue } from '../../conflicts.js';
import { BadMappingError } from '../../errors.js';
import type { FactInput, GstTreatment, ProductValue } from '../../types.js';
import { parsePrice, parseStock } from './money.js';
import { SHEET_FIELDS, type ColumnMapping, type SheetField } from './suggest.js';
import type { SheetRow } from './table.js';

/** Why a row isn't imported (FEAT-016 §5.5): skipped (`excluded`) or rejected (`failed`). */
export type SkipReason = 'empty_row' | 'duplicate';
export type RejectReason =
  'no_name' | 'no_price' | 'bad_price' | 'not_sgd' | 'bad_stock' | 'too_long';

export type ProductInput = Extract<FactInput, { type: 'product' }>;

export type RowOutcome =
  | { row: number; status: 'included'; reason: null; input: ProductInput }
  | { row: number; status: 'excluded'; reason: SkipReason; input: null }
  | { row: number; status: 'failed'; reason: RejectReason; input: null };

export const MAX_NAME = 200;
export const MAX_UNIT = 60;
export const MAX_SKU = 64;

const FIELD_NAME: Record<SheetField, string> = {
  product: 'Product name',
  service: 'Service name',
  price: 'Price',
  unit: 'Unit or size',
  sku: 'SKU or item code',
  stock: 'Stock',
};

/**
 * Checks a mapping against a sheet of `width` columns (FEAT-016 §5.6): a name column and
 * a price column are needed, each index must be in the sheet, and a column maps to one
 * field. Throws `BadMappingError` with the owner-facing message.
 */
export function checkMapping(width: number, mapping: ColumnMapping): void {
  if (mapping.product === undefined && mapping.service === undefined)
    throw new BadMappingError('Choose the column with the product or service names');
  if (mapping.price === undefined) throw new BadMappingError('Choose the column with the prices');
  const seen = new Map<number, SheetField>();
  for (const field of SHEET_FIELDS) {
    const i = mapping[field];
    if (i === undefined) continue;
    if (!Number.isInteger(i) || i < 0 || i >= width)
      throw new BadMappingError(`That column isn't in this sheet (${FIELD_NAME[field]})`);
    if (seen.has(i))
      throw new BadMappingError(
        `One column can't be used for two fields (${FIELD_NAME[seen.get(i)!]} and ${FIELD_NAME[field]})`,
      );
    seen.set(i, field);
  }
}

/**
 * Each row's outcome under a mapping (FEAT-016 §5.5), in sheet order: the first rule that
 * applies decides it, and an importable row becomes a product fact with the import's GST
 * treatment. `asOf` (`YYYY-MM-DD`) dates a row's stock. Pure; the preview and the import
 * stage both call it (D4).
 */
export function mapRows(
  rows: readonly SheetRow[],
  mapping: ColumnMapping,
  gst: GstTreatment,
  opts: { asOf: string },
): RowOutcome[] {
  const cell = (r: SheetRow, f: SheetField) => {
    const i = mapping[f];
    return i === undefined ? '' : (r.cells[i] ?? '').trim();
  };
  const kept: ProductInput[] = [];
  return rows.map((r): RowOutcome => {
    const { row } = r;
    const fail = (reason: RejectReason): RowOutcome => ({
      row,
      status: 'failed',
      reason,
      input: null,
    });
    if (SHEET_FIELDS.every((f) => cell(r, f) === ''))
      return { row, status: 'excluded', reason: 'empty_row', input: null };
    const name = cell(r, 'product') || cell(r, 'service');
    if (!name) return fail('no_name');
    const priceCell = cell(r, 'price');
    if (!priceCell) return fail('no_price');
    const price = parsePrice(priceCell);
    if (!price.ok) return fail(price.reason);
    const stockCell = cell(r, 'stock');
    const stock = stockCell === '' ? null : parseStock(stockCell);
    if (stockCell !== '' && stock === null) return fail('bad_stock');
    const unit = cell(r, 'unit');
    const sku = cell(r, 'sku');
    if (name.length > MAX_NAME || unit.length > MAX_UNIT || sku.length > MAX_SKU)
      return fail('too_long');
    const value: ProductValue = { name, priceCents: price.cents, currency: 'SGD' };
    if (unit) value.unit = unit;
    if (sku) value.sku = sku;
    if (stock !== null) {
      value.stock = stock;
      value.stockAsOf = opts.asOf;
    }
    const input: ProductInput = { type: 'product', value, gstTreatment: gst };
    if (kept.some((k) => sameValue(k, input)))
      return { row, status: 'excluded', reason: 'duplicate', input: null };
    kept.push(input);
    return { row, status: 'included', reason: null, input };
  });
}
