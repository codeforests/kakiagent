import { describe, expect, it } from 'vitest';
import { centsText, looksLikePrice, parsePrice, parseStock } from './money.js';

describe('parsePrice (FEAT-016 §5.5 rules 4–5)', () => {
  it.each([
    ['38', 3800],
    ['38.5', 3850],
    ['$38.50', 3850],
    ['S$ 38.50', 3850],
    ['SGD 1,200.00', 120000],
    ['1,200.5 SGD', 120050],
    ['12$', 1200],
    ['0', 0],
    ['5.499999999999', 550],
    ['9999999.99', 999999999],
  ])('%s → %i cents', (raw, cents) => expect(parsePrice(raw)).toEqual({ ok: true, cents }));

  it.each(['RM 12', 'MYR12', 'USD 5', 'US$5', '€5', '£5', '¥500', '50元', 'HK$10', '5 AUD'])(
    '%s is another currency',
    (raw) => expect(parsePrice(raw)).toEqual({ ok: false, reason: 'not_sgd' }),
  );

  it.each(['TBC', 'Free', '5-10', '-5', '5.555', '1,20', '10000000', '$', '', '1.2.3', 'abc12'])(
    '%s is not a price',
    (raw) => expect(parsePrice(raw)).toEqual({ ok: false, reason: 'bad_price' }),
  );

  it('tells prices from text for header detection', () => {
    expect(looksLikePrice('$5')).toBe(true);
    expect(looksLikePrice('RM 5')).toBe(true);
    expect(looksLikePrice('Price')).toBe(false);
    expect(looksLikePrice('')).toBe(false);
    expect(centsText(3850)).toBe('38.50');
  });
});

describe('parseStock (FEAT-016 §5.5 rule 6)', () => {
  it.each([
    ['12', 12],
    ['12.0', 12],
    ['1,200', 1200],
    [' 0 ', 0],
  ])('%s → %i', (raw, n) => expect(parseStock(raw)).toBe(n));
  it.each(['-1', '1.5', 'many', '12 pcs', ''])('%s is not a count', (raw) =>
    expect(parseStock(raw)).toBeNull(),
  );
});
