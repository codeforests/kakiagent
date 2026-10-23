import { describe, expect, it } from 'vitest';
import {
  columnLetter,
  MAX_CELL_CHARS,
  SHEET_COLUMN_LIMIT,
  tableOf,
  type SheetRow,
} from './table.js';

const rows = (...r: string[][]): SheetRow[] => r.map((cells, i) => ({ row: i + 1, cells }));

describe('tableOf (FEAT-016 §5.3 step 4)', () => {
  it('finds the header below a title row and keeps sheet row numbers', () => {
    const t = tableOf(
      rows(
        ['Kaki Bakery price list 2026'],
        [],
        ['Code', 'Product', 'Price'],
        ['PC-01', 'Pandan chiffon', '38'],
        ['', '', ''],
        ['PC-02', 'Ondeh cake', '42'],
        [],
      ),
    )!;
    expect(t.headerRow).toBe(3);
    expect(t.columns.map((c) => c.header)).toEqual(['Code', 'Product', 'Price']);
    expect(t.columns[1]!.samples).toEqual(['Pandan chiffon', 'Ondeh cake']);
    expect(t.rows.map((r) => r.row)).toEqual([4, 5, 6]);
    expect(t.rows[1]!.cells).toEqual(['', '', '']);
    expect(t.rowsSkipped).toBe(0);
  });

  it('skips a numeric first row as the header and names empty headers by their letter', () => {
    const t = tableOf(rows(['1', '2'], ['Name', '', 'Price'], ['Kaya', 'x', '5']))!;
    expect(t.headerRow).toBe(2);
    expect(t.columns.map((c) => c.header)).toEqual(['Name', 'Column B', 'Price']);
  });

  it('falls back to the first non-empty row when no row looks like a header', () => {
    const t = tableOf(rows([], ['12', '13'], ['14', '15']))!;
    expect(t.headerRow).toBe(2);
    expect(t.rows).toEqual([{ row: 3, cells: ['14', '15'] }]);
  });

  it('applies the row limit, counting the rest, and the column and cell limits', () => {
    const many = rows(['Name', 'Price'], ...Array.from({ length: 12 }, (_, i) => [`p${i}`, '1']));
    const t = tableOf(many, { rowLimit: 10 })!;
    expect(t.rows).toHaveLength(10);
    expect(t.rowsSkipped).toBe(2);
    const wide = tableOf(
      rows(
        Array.from({ length: 60 }, (_, i) => `h${i}`),
        [' x'.repeat(800), ...Array.from({ length: 59 }, () => 'v')],
      ),
    )!;
    expect(wide.columns).toHaveLength(SHEET_COLUMN_LIMIT);
    expect(wide.rows[0]!.cells[0]!.length).toBe(MAX_CELL_CHARS);
  });

  it('masks cells, headers and samples', () => {
    const t = tableOf(rows(['Name', 'Price'], ['secret', '1']), {
      mask: (s) => s.replace('secret', '[x]'),
    })!;
    expect(t.rows[0]!.cells[0]).toBe('[x]');
    expect(t.columns[0]!.samples).toEqual(['[x]']);
  });

  it('is null without a header or without a data row (no_rows)', () => {
    expect(tableOf([])).toBeNull();
    expect(tableOf(rows([], ['']))).toBeNull();
    expect(tableOf(rows(['Name', 'Price'], ['', '']))).toBeNull();
  });

  it('names columns like a spreadsheet', () => {
    expect([0, 2, 25, 26, 51, 701, 702].map(columnLetter)).toEqual([
      'A',
      'C',
      'Z',
      'AA',
      'AZ',
      'ZZ',
      'AAA',
    ]);
  });
});
