import { describe, expect, it } from 'vitest';
import { readTsv } from './tesseract.js';

const HEAD =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (block: number, line: number, n: number, conf: number, text: string) =>
  `5\t1\t${block}\t1\t${line}\t${n}\t0\t0\t10\t10\t${conf}\t${text}`;

describe('readTsv', () => {
  it('regroups words into lines by block, paragraph and line', () => {
    const tsv = [
      HEAD,
      '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
      word(1, 1, 1, 90, 'Egg'),
      word(1, 1, 2, 90, 'tarts'),
      word(1, 2, 1, 90, 'S$12.60'),
      word(2, 1, 1, 90, 'Menu'),
    ].join('\n');
    expect(readTsv(tsv).text).toBe('Egg tarts\nS$12.60\nMenu');
  });

  it('removes the spaces Tesseract puts between two CJK characters only', () => {
    const tsv = [
      HEAD,
      ...['本', '店', '营业', '，', 'Kaki', 'Bakery', '休息', '。'].map((w, i) =>
        word(1, 1, i + 1, 80, w),
      ),
    ].join('\n');
    expect(readTsv(tsv).text).toBe('本店营业， Kaki Bakery 休息。');
  });

  it('weights confidence by word length and ignores non-words', () => {
    const tsv = [
      HEAD,
      word(1, 1, 1, 90, 'abcd'), // 4 chars at 90
      word(1, 1, 2, 60, 'ab'), // 2 chars at 60
      word(1, 1, 3, -1, 'zz'), // not a word
      word(1, 1, 4, 95, '   '), // empty
    ].join('\n');
    expect(readTsv(tsv)).toEqual({ text: 'abcd ab', confidence: 0.8 });
  });

  it('gives no text and zero confidence for an empty page', () => {
    expect(readTsv(`${HEAD}\n1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n`)).toEqual({
      text: '',
      confidence: 0,
    });
  });
});
