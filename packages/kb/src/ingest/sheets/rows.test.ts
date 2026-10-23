import { describe, expect, it } from 'vitest';
import { BadMappingError } from '../../errors.js';
import { checkMapping, mapRows } from './rows.js';

const M = { sku: 0, product: 1, unit: 2, price: 3, stock: 4 };
const run = (cells: string[][], mapping = M, gst = 'inclusive' as const) =>
  mapRows(
    cells.map((c, i) => ({ row: i + 2, cells: c })),
    mapping,
    gst,
    { asOf: '2026-10-23' },
  );

describe('mapRows (FEAT-016 §5.5)', () => {
  it('turns a valid row into an approved-to-be product with SKU, unit and dated stock', () => {
    expect(run([['PC-01', 'Pandan chiffon', 'whole', '$38.00', '12']])).toEqual([
      {
        row: 2,
        status: 'included',
        reason: null,
        input: {
          type: 'product',
          value: {
            name: 'Pandan chiffon',
            priceCents: 3800,
            currency: 'SGD',
            unit: 'whole',
            sku: 'PC-01',
            stock: 12,
            stockAsOf: '2026-10-23',
          },
          gstTreatment: 'inclusive',
        },
      },
    ]);
    const bare = run([['', 'Kaya toast', '', '2.5', '']])[0]!;
    expect(bare.input?.value).toEqual({ name: 'Kaya toast', priceCents: 250, currency: 'SGD' });
  });

  it('applies the rules in order: empty, name, price, currency, amount, stock, length, duplicate', () => {
    const out = run([
      ['', '', '', '', ''],
      ['X', '', '', '5', ''],
      ['X', 'No price', '', '', '1'],
      ['X', 'Ringgit', '', 'RM 5', 'x'],
      ['X', 'Later', '', 'TBC', 'x'],
      ['X', 'Negative stock', '', '5', '-1'],
      ['X', 'n'.repeat(201), '', '5', ''],
      ['X'.repeat(65), 'Long SKU', '', '5', ''],
      ['', 'Kaya', '', '5', ''],
      ['', 'kaya ', '', '5.00', '3'],
      ['', 'Kaya', '', '6', ''],
    ]);
    expect(out.map((o) => [o.row, o.status, o.reason])).toEqual([
      [2, 'excluded', 'empty_row'],
      [3, 'failed', 'no_name'],
      [4, 'failed', 'no_price'],
      [5, 'failed', 'not_sgd'],
      [6, 'failed', 'bad_price'],
      [7, 'failed', 'bad_stock'],
      [8, 'failed', 'too_long'],
      [9, 'failed', 'too_long'],
      [10, 'included', null],
      [11, 'excluded', 'duplicate'],
      // Same product, another price: kept; the promote stage conflicts the two (KB-06).
      [12, 'included', null],
    ]);
  });

  it('names a row from the service column when the product cell is empty, and ignores unmapped columns', () => {
    const out = mapRows(
      [{ row: 2, cells: ['', 'Haircut', '25', 'ignored'] }],
      { product: 0, service: 1, price: 2 },
      'unknown',
      { asOf: '2026-10-23' },
    );
    expect(out[0]!.input).toEqual({
      type: 'product',
      value: { name: 'Haircut', priceCents: 2500, currency: 'SGD' },
      gstTreatment: 'unknown',
    });
    // A row whose only content is outside the mapped columns is empty under this mapping.
    expect(
      mapRows([{ row: 3, cells: ['', '', '', 'x'] }], { product: 0, price: 2 }, 'inclusive', {
        asOf: 'd',
      })[0]!.reason,
    ).toBe('empty_row');
  });
});

describe('checkMapping (FEAT-016 §5.6)', () => {
  const msg = (width: number, m: object) => {
    try {
      checkMapping(width, m);
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(BadMappingError);
      return (e as Error).message;
    }
  };
  it('needs a name and a price column, in the sheet, each used once', () => {
    expect(msg(3, { product: 0, price: 1 })).toBeNull();
    expect(msg(3, { service: 0, price: 1, stock: 2 })).toBeNull();
    expect(msg(3, { price: 1 })).toBe('Choose the column with the product or service names');
    expect(msg(3, { product: 0 })).toBe('Choose the column with the prices');
    expect(msg(3, { product: 0, price: 3 })).toBe("That column isn't in this sheet (Price)");
    expect(msg(3, { product: 0, price: 1, sku: 0 })).toBe(
      "One column can't be used for two fields (Product name and SKU or item code)",
    );
  });
});
