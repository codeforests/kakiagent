import { describe, expect, it } from 'vitest';
import { PASSAGE_CONTEXT, passageOf } from './review.js';

describe('passageOf (FEAT-013 D6)', () => {
  const quote = 'Chocolate fudge cake (1 kg) — S$55.00';

  it('gives the whole page around a quote on a short page', () => {
    const page = `Our signature ${quote}, eggless on request.`;
    const start = page.indexOf(quote);
    expect(passageOf(page, quote, start, start + quote.length)).toEqual({
      before: 'Our signature ',
      quote,
      after: ', eggless on request.',
    });
  });

  it('cuts long context at whole words with an ellipsis', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const page = `${words(60)} ${quote} ${words(60)}`;
    const start = page.indexOf(quote);
    const p = passageOf(page, quote, start, start + quote.length);
    expect(p.quote).toBe(quote);
    expect(p.before.startsWith('…word')).toBe(true);
    expect(p.before.length).toBeLessThanOrEqual(PASSAGE_CONTEXT);
    expect(page.slice(0, start).endsWith(p.before.slice(1))).toBe(true);
    expect(p.after.endsWith('…')).toBe(true);
    expect(p.after.length).toBeLessThanOrEqual(PASSAGE_CONTEXT + 1);
    expect(page.slice(start + quote.length).startsWith(p.after.slice(0, -1))).toBe(true);
    expect(p.after.slice(0, -1)).toMatch(/word\d+$/);
  });

  it('falls back to the quote alone when the offsets miss or the page is gone', () => {
    expect(passageOf('something else entirely', quote, 0, quote.length)).toEqual({
      before: '',
      quote,
      after: '',
    });
    expect(passageOf(null, quote, 0, 10)).toEqual({ before: '', quote, after: '' });
  });
});
