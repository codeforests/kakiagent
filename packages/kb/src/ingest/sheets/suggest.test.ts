import { describe, expect, it } from 'vitest';
import { suggestMapping } from './suggest.js';
import type { SheetColumn, SheetRow } from './table.js';

const cols = (...headers: string[]): SheetColumn[] =>
  headers.map((header, index) => ({ index, header, samples: [] }));
const rows = (...r: string[][]): SheetRow[] => r.map((cells, i) => ({ row: i + 2, cells }));

describe('suggestMapping (FEAT-016 §5.4)', () => {
  it('maps English headers by their words', () => {
    expect(
      suggestMapping(cols('Item code', 'Product', 'Size', 'Price (incl. GST)', 'Stock'), []),
    ).toEqual({
      columns: { sku: 0, product: 1, unit: 2, price: 3, stock: 4 },
      gst: 'inclusive',
    });
    expect(suggestMapping(cols('Service', 'Rate'), []).columns).toEqual({ service: 0, price: 1 });
    expect(suggestMapping(cols('Description', 'Qty', 'Unit Price', 'UOM'), []).columns).toEqual({
      product: 0,
      stock: 1,
      price: 2,
      unit: 3,
    });
  });

  it('maps Chinese headers', () => {
    expect(suggestMapping(cols('货号', '品名', '规格', '单价', '库存'), []).columns).toEqual({
      sku: 0,
      product: 1,
      unit: 2,
      price: 3,
      stock: 4,
    });
  });

  it('never takes a cost column as the price (D7), and prefers the better name word', () => {
    expect(suggestMapping(cols('Name', 'Cost price', 'Selling price'), []).columns).toEqual({
      product: 0,
      price: 2,
    });
    expect(suggestMapping(cols('Description', 'Product', 'Cost'), []).columns).toEqual({
      product: 1,
    });
  });

  it('falls back to values: prices with decimals or a currency, and names', () => {
    const r = rows(['Kaya toast', '12', '2.50'], ['Kopi', '30', '1.80']);
    expect(suggestMapping(cols('A', 'B', 'C'), r).columns).toEqual({ price: 2, product: 0 });
    // Small whole numbers without a currency look like counts.
    expect(suggestMapping(cols('A', 'B'), rows(['x', '12'], ['y', '30'])).columns).toEqual({
      product: 0,
    });
    expect(suggestMapping(cols('A', 'B'), rows(['x', '$12'], ['y', '$30'])).columns).toEqual({
      product: 0,
      price: 1,
    });
  });

  it('suggests GST from the price header, or nothing', () => {
    const gst = (h: string) => suggestMapping(cols('Name', h), []).gst;
    expect(gst('Price (excl. GST)')).toBe('exclusive');
    expect(gst('Price + GST')).toBe('exclusive');
    expect(gst('Price before GST')).toBe('exclusive');
    expect(gst('价格（不含税）')).toBe('exclusive');
    expect(gst('Price w/ GST')).toBe('inclusive');
    expect(gst('Nett price')).toBe('inclusive');
    expect(gst('价格（含税）')).toBe('inclusive');
    expect(gst('Price')).toBeNull();
    expect(suggestMapping(cols('Name'), []).gst).toBeNull();
  });
});
