import type { GstTreatment } from '../../types.js';
import { hasCurrency, parsePrice } from './money.js';
import type { SheetColumn, SheetRow } from './table.js';

/** The fields a column can map to (FEAT-016 §3.1); product and service both name a fact. */
export const SHEET_FIELDS = ['product', 'service', 'price', 'unit', 'sku', 'stock'] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];
/** Field → 0-based column index. */
export type ColumnMapping = Partial<Record<SheetField, number>>;

export interface Suggestion {
  columns: ColumnMapping;
  gst: GstTreatment | null;
}

/** Header words per field, tried in this field order and keyword order (§5.4). */
const KEYWORDS: [SheetField, string[]][] = [
  [
    'sku',
    [
      'sku',
      'item code',
      'product code',
      'barcode',
      'item no',
      'part no',
      'code',
      '货号',
      '编号',
      '条码',
    ],
  ],
  [
    'price',
    [
      'selling price',
      'retail price',
      'unit price',
      'price',
      'rate',
      'amount',
      'sgd',
      's$',
      '$',
      '价格',
      '售价',
      '单价',
      '价钱',
    ],
  ],
  [
    'stock',
    ['stock', 'qty', 'quantity', 'inventory', 'on hand', 'available', 'balance', '库存', '数量'],
  ],
  ['unit', ['unit', 'uom', 'size', 'per', 'pack', '单位', '规格']],
  ['service', ['service', 'treatment', 'package', '服务', '项目']],
  [
    'product',
    [
      'product',
      'item',
      'name',
      'description',
      'menu',
      'dish',
      '产品',
      '品名',
      '名称',
      '商品',
      '菜名',
    ],
  ],
];

/** Lower case, punctuation (but `$`) as spaces, spaces collapsed. */
export const normaliseHeader = (h: string) =>
  ` ${h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$]+/gu, ' ')
    .trim()} `;

const CJK = /\p{Script=Han}/u;
/** A whole-word match for Latin keywords; a substring for Chinese ones. */
const matches = (header: string, kw: string) =>
  CJK.test(kw) ? header.includes(kw) : header.includes(` ${normaliseHeader(kw).trim()} `);

/** A purchase price is never a selling price (D7). */
const isCost = (header: string) => /\bcost\b|成本/.test(header);

const SAMPLE_ROWS = 20;
/** "Price (excl. GST)", "Price + GST", "不含税"; checked before the inclusive words. */
const EXCL_GST = /\b(?:excl|exclusive|excluding|before gst|without gst|w\/o gst)\b|\+ ?gst|不含税/;
const INCL_GST = /\b(?:incl|inclusive|including|with gst|w\/ ?gst|nett)\b|含税/;

/**
 * The suggested mapping (FEAT-016 §5.4): each field takes the first unused column whose
 * header matches its words; then, for price and name still unmapped, a column whose
 * values look like prices or like names. The GST choice comes from the price header.
 */
export function suggestMapping(columns: SheetColumn[], rows: SheetRow[]): Suggestion {
  const headers = columns.map((c) => normaliseHeader(c.header));
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const take = (field: SheetField, i: number) => {
    mapping[field] = i;
    used.add(i);
  };
  for (const [field, words] of KEYWORDS) {
    for (const kw of words) {
      const i = headers.findIndex(
        (h, i) => !used.has(i) && matches(h, kw) && !(field === 'price' && isCost(h)),
      );
      if (i >= 0) {
        take(field, i);
        break;
      }
    }
  }
  const values = (i: number) =>
    rows
      .slice(0, SAMPLE_ROWS)
      .map((r) => r.cells[i] ?? '')
      .filter((c) => c !== '');
  const free = columns.map((c) => c.index).filter((i) => !used.has(i) && !isCost(headers[i]!));
  if (mapping.price === undefined) {
    const i = free.find((i) => {
      const v = values(i);
      if (!v.length || !v.every((c) => parsePrice(c).ok)) return false;
      // Whole numbers under 1,000 with no currency look like counts, not prices.
      return !v.every((c) => /^\d{1,3}$/.test(c.trim()) && !hasCurrency(c));
    });
    if (i !== undefined) take('price', i);
  }
  if (mapping.product === undefined && mapping.service === undefined) {
    const i = free.find((i) => {
      if (used.has(i)) return false;
      const v = values(i);
      return v.length > 0 && v.filter((c) => !/\d/.test(c)).length * 2 >= v.length;
    });
    if (i !== undefined) take('product', i);
  }
  const priceHeader =
    mapping.price === undefined ? '' : (columns[mapping.price]?.header ?? '').toLowerCase();
  const gst: GstTreatment | null = EXCL_GST.test(priceHeader)
    ? 'exclusive'
    : INCL_GST.test(priceHeader)
      ? 'inclusive'
      : null;
  return { columns: mapping, gst };
}
