import { describe, expect, it } from 'vitest';
import { delimiterOf, readCsv } from './csv.js';

describe('readCsv (FEAT-016 §5.3 step 2)', () => {
  it('reads quoted fields with commas, escaped quotes and line breaks, keeping row numbers', () => {
    const rows = readCsv(
      'Name,Price\r\n"Cake, pandan",38\r\n"The ""big"" one","1,200.50"\r\n"Two\nlines",5\r\n',
    );
    expect(rows).toEqual([
      { row: 1, cells: ['Name', 'Price'] },
      { row: 2, cells: ['Cake, pandan', '38'] },
      { row: 3, cells: ['The "big" one', '1,200.50'] },
      { row: 4, cells: ['Two\nlines', '5'] },
    ]);
  });

  it('takes the delimiter used most in the first line: semicolons and tabs too', () => {
    expect(delimiterOf('Service;Price;Unit\na,b;c')).toBe(';');
    expect(delimiterOf('A\tB\tC')).toBe('\t');
    expect(delimiterOf('"a;b;c",d')).toBe(',');
    expect(delimiterOf('single')).toBe(',');
    expect(readCsv('Service;Price\n"Cut; wash";25')).toEqual([
      { row: 1, cells: ['Service', 'Price'] },
      { row: 2, cells: ['Cut; wash', '25'] },
    ]);
  });

  it('keeps blank lines as empty rows and reads a last line without a line break', () => {
    expect(readCsv('a,b\n\nc,d')).toEqual([
      { row: 1, cells: ['a', 'b'] },
      { row: 2, cells: [''] },
      { row: 3, cells: ['c', 'd'] },
    ]);
    expect(readCsv('a,b\n')).toEqual([{ row: 1, cells: ['a', 'b'] }]);
    expect(readCsv('')).toEqual([]);
  });
});
