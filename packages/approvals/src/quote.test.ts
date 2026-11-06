import { describe, expect, it } from 'vitest';
import {
  draftLines,
  headline,
  kindOf,
  parseDiscount,
  parseQuantity,
  quoteText,
  tokens,
  totalsOf,
  type PricedProduct,
} from './quote.js';

const product = (name: string, priceCents: number, i = 1): PricedProduct => ({
  factId: `00000000-0000-4000-8000-00000000000${i}`,
  version: 1,
  name,
  unit: 'piece',
  priceCents,
  gst: 'inclusive',
});
const vanilla = product('Vanilla cupcake', 350, 1);
const choc = product('Chocolate fudge cake', 4_800, 2);
const box = product('Gift box', 500, 3);
const tart = product('蛋挞', 280, 4);
const mooncake = product('莲蓉月饼', 1_200, 5);

describe('matching (FEAT-055 §5.1, D2)', () => {
  it('tokens: words of 3+ letters, stemmed; Han by bigram', () => {
    expect([...tokens('200 Cupcakes, a box & berries')]).toEqual(['cupcake', 'box', 'berry']);
    expect([...tokens('我要莲蓉月饼')].sort()).toEqual(
      ['我要', '要莲', '莲蓉', '蓉月', '月饼'].sort(),
    );
  });

  it('matches English plurals to product names, best first, at the asked quantity', () => {
    const lines = draftLines('200 vanilla cupcakes', '200', [choc, box, vanilla]);
    expect(lines).toEqual([
      {
        factId: vanilla.factId,
        factVersion: 1,
        label: 'Vanilla cupcake',
        unit: 'piece',
        quantity: 200,
        unitPriceCents: 350,
      },
    ]);
    // Two shared words beat one; ties keep the retrieval order; at most three lines.
    expect(
      draftLines('cupcakes and a cake in a gift box', undefined, [choc, box, vanilla]).map(
        (l) => l.label,
      ),
    ).toEqual(['Gift box', 'Chocolate fudge cake', 'Vanilla cupcake']);
  });

  it('matches Chinese by character bigram', () => {
    expect(
      draftLines('想订50个月饼', '50个', [vanilla, tart, mooncake]).map((l) => [
        l.label,
        l.quantity,
      ]),
    ).toEqual([['莲蓉月饼', 50]]);
  });

  it('no match gives no lines; quantity falls back to 1 when out of range', () => {
    expect(draftLines('a wedding arch', '2', [vanilla, choc])).toEqual([]);
    expect(draftLines(undefined, '2', [vanilla])).toEqual([]);
    expect(draftLines('cupcakes', 'lots', [vanilla])[0]!.quantity).toBe(1);
    expect(draftLines('cupcakes', '1,000,000', [vanilla])[0]!.quantity).toBe(1);
    expect(parseQuantity('1,200 pcs')).toBe(1_200);
  });

  it('parses a discount and picks the kind', () => {
    expect(parseDiscount('15%')).toBe(15);
    expect(parseDiscount(10)).toBe(10);
    expect(parseDiscount('any discount?')).toBeNull();
    expect(parseDiscount(150)).toBeNull();
    const line = draftLines('cupcakes', '2', [vanilla]);
    expect(kindOf({}, 15, line)).toBe('discount');
    expect(kindOf({}, null, line)).toBe('quote');
    expect(kindOf({ quantity: '30' }, null, [])).toBe('quote');
    expect(kindOf({ date: 'Friday' }, null, [])).toBe('commitment');
    expect(kindOf({}, 0, [])).toBe('commitment');
  });
});

describe('quote text (FEAT-055 §5.1)', () => {
  const terms = {
    lines: draftLines('cupcakes', '200', [vanilla]),
    discountPct: 15,
    note: 'Delivery on Friday is fine.',
  };
  const totals = totalsOf(terms, 'inclusive');

  it('English: lines, discount, total with GST, then the note', () => {
    expect(quoteText('en', 'Kaki Bakery', terms, totals)).toBe(
      [
        "Here's your quote from Kaki Bakery:",
        '200 × Vanilla cupcake at S$3.50 = S$700.00',
        '15% off: -S$105.00',
        'Total S$595.00 (incl. GST)',
        'Delivery on Friday is fine.',
      ].join('\n'),
    );
  });

  it('Chinese', () => {
    expect(quoteText('zh', 'Kaki Bakery', terms, totals)).toBe(
      [
        '这是Kaki Bakery给您的报价：',
        '200 × Vanilla cupcake，单价 S$3.50 = S$700.00',
        '优惠 15%：-S$105.00',
        '总计 S$595.00（含消费税）',
        'Delivery on Friday is fine.',
      ].join('\n'),
    );
  });

  it('a note-only commitment has no total line; the headline names the request', () => {
    const note = { lines: [], discountPct: 0, note: 'Yes, we can deliver on Friday.' };
    expect(quoteText('en', 'Kaki', note, totalsOf(note, 'none'))).toBe(
      "Here's your quote from Kaki:\nYes, we can deliver on Friday.",
    );
    expect(headline(note, { items: 'Friday delivery' })).toBe('Friday delivery');
    expect(headline(note, { items: null })).toBe('Custom request');
    expect(headline(terms, { items: 'cupcakes' })).toBe('200 × Vanilla cupcake · 15% off');
    expect(
      headline(
        { ...terms, lines: [...terms.lines, ...terms.lines, ...terms.lines] },
        { items: null },
      ),
    ).toBe('200 × Vanilla cupcake +2 more · 15% off');
  });
});
