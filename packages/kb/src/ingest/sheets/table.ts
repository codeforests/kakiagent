import { looksLikePrice } from './money.js';

/** A row as read from the sheet, with its 1-based row number (blank rows included). */
export interface SheetRow {
  row: number;
  cells: string[];
}

/** FEAT-016 §5.3 step 4 and D10. */
export const SHEET_COLUMN_LIMIT = 50;
export const DEFAULT_SHEET_ROW_LIMIT = 2000;
export const MAX_CELL_CHARS = 1000;
/** Header candidates are looked for in the first rows only. */
const HEADER_SEARCH = 10;
const SAMPLES = 3;

export interface SheetColumn {
  index: number;
  header: string;
  samples: string[];
}

export interface SheetTable {
  headerRow: number;
  columns: SheetColumn[];
  /** Data rows after the header, at most the row limit, trailing empty rows dropped. */
  rows: SheetRow[];
  rowsSkipped: number;
}

/** "C" for index 2; "AA" for 26. */
export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const filled = (cells: string[]) => cells.filter((c) => c !== '');
const isNumeric = (c: string) => looksLikePrice(c) || /^-?[\d.,\s]+%?$/.test(c);

/**
 * The header row: the first among the first 10 with at least two non-empty cells, at
 * least half of them not numbers or prices; failing that, the first non-empty row.
 */
function headerIndex(rows: SheetRow[]): number {
  const firstFilled = rows.findIndex((r) => filled(r.cells).length > 0);
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH); i++) {
    const cells = filled(rows[i]!.cells);
    if (cells.length >= 2 && cells.filter((c) => !isNumeric(c)).length * 2 >= cells.length)
      return i;
  }
  return firstFilled;
}

/**
 * The table in a sheet's rows (FEAT-016 §5.3 step 4): cells trimmed and cut at 1,000
 * characters, at most 50 columns, the header found, an empty header named by its column
 * letter, and the data rows after it up to `rowLimit` (later ones are only counted).
 * Null when there is no header or no data row (`no_rows`). `mask` is applied to every
 * stored cell, header and sample (ADR-015).
 */
export function tableOf(
  sheet: SheetRow[],
  opts: { rowLimit?: number; mask?: (s: string) => string } = {},
): SheetTable | null {
  const mask = opts.mask ?? ((s: string) => s);
  const rows = sheet.map((r) => ({
    row: r.row,
    cells: r.cells.slice(0, SHEET_COLUMN_LIMIT).map((c) => c.trim().slice(0, MAX_CELL_CHARS)),
  }));
  const h = headerIndex(rows);
  if (h < 0) return null;
  const data = rows.slice(h + 1);
  while (data.length && !filled(data[data.length - 1]!.cells).length) data.pop();
  if (!data.some((r) => filled(r.cells).length)) return null;
  const header = rows[h]!;
  const width = Math.max(
    ...[header, ...data].map((r) => r.cells.reduce((w, c, i) => (c !== '' ? i + 1 : w), 0)),
  );
  const limit = opts.rowLimit ?? DEFAULT_SHEET_ROW_LIMIT;
  const kept = data.slice(0, limit).map((r) => ({
    row: r.row,
    cells: Array.from({ length: width }, (_, i) => mask(r.cells[i] ?? '')),
  }));
  const columns = Array.from({ length: width }, (_, index) => ({
    index,
    header: mask(header.cells[index] ?? '') || `Column ${columnLetter(index)}`,
    samples: kept
      .map((r) => r.cells[index]!)
      .filter((c) => c !== '')
      .slice(0, SAMPLES),
  }));
  return {
    headerRow: header.row,
    columns,
    rows: kept,
    rowsSkipped: Math.max(0, data.length - limit),
  };
}
