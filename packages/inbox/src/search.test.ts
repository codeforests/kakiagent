import { describe, expect, it } from 'vitest';
import { excerptOf, searchPatterns, searchTerms } from './search.js';

const marked = (r: ReturnType<typeof excerptOf>) =>
  r.ranges.map((x) => r.excerpt.slice(x.start, x.end));

describe('searchPatterns (FEAT-046 §5.1)', () => {
  it('wraps the trimmed, collapsed query and escapes LIKE metacharacters', () => {
    expect(searchPatterns('  Jane \t Doe ')).toEqual(['%Jane Doe%']);
    expect(searchPatterns('50%_off\\now')).toEqual(['%50\\%\\_off\\\\now%']);
  });

  it('masks an NRIC so it matches the stored token, never the raw number', () => {
    expect(searchTerms('S1234567D')).toEqual(['[NRIC ••••567D]']);
    expect(searchPatterns('S1234567D')?.join()).not.toContain('1234567');
  });

  it('gives the same three phone variants for each SG spelling (D6)', () => {
    const variants = ['%91234567%', '%9123 4567%', '%9123-4567%'];
    for (const q of ['9123 4567', '+65-9123-4567', '91234567', '+65 9123 4567', '6591234567']) {
      const p = searchPatterns(q)!;
      for (const v of variants) expect(p, q).toContain(v);
      expect(new Set(p).size, q).toBe(p.length);
    }
    expect(searchPatterns('91234567')).toEqual(variants);
    expect(searchPatterns('12345678')).toEqual(['%12345678%']);
    expect(searchPatterns('9123456')).toEqual(['%9123456%']);
  });

  it('is null under 2 characters after trimming and masking', () => {
    expect(searchPatterns(' a ')).toBeNull();
    expect(searchPatterns('😀')).toBeNull();
    expect(searchPatterns('美玲')).toEqual(['%美玲%']);
  });
});

describe('excerptOf (FEAT-046 §5.1)', () => {
  it('returns a short body whole with every hit, case-insensitive', () => {
    const r = excerptOf('Jane here, email JANE@example.com', ['jane']);
    expect(r.excerpt).toBe('Jane here, email JANE@example.com');
    expect(r.ranges).toEqual([
      { start: 0, end: 4 },
      { start: 17, end: 21 },
    ]);
  });

  it('cuts a long body around the first hit on spaces, marking cuts with …', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const body = `${words} needle ${words}`;
    const r = excerptOf(body, ['needle']);
    expect(r.excerpt.startsWith('…')).toBe(true);
    expect(r.excerpt.endsWith('…')).toBe(true);
    expect(r.excerpt.length).toBeLessThanOrEqual(160);
    expect(r.excerpt[1]).not.toBe(' ');
    expect(
      r.excerpt
        .slice(1, -1)
        .split(' ')
        .every((w) => /^(word\d+|needle)$/.test(w)),
    ).toBe(true);
    expect(marked(r)).toEqual(['needle']);
    expect(r.ranges[0]!.start).toBeLessThanOrEqual(41 + 10);
  });

  it('marks several hits and several needles, merged and sorted', () => {
    const r = excerptOf('call 9123 4567 or 91234567 or 9123-4567', [
      '9123 4567',
      '91234567',
      '9123-4567',
    ]);
    expect(marked(r)).toEqual(['9123 4567', '91234567', '9123-4567']);
  });

  it('handles Chinese text', () => {
    const r = excerptOf('您好，我是陈美玲，想订蛋糕', ['美玲']);
    expect(marked(r)).toEqual(['美玲']);
  });

  it('never splits an emoji at either cut', () => {
    const body = '😀'.repeat(60) + ' needle ' + '😀'.repeat(120);
    const r = excerptOf(body, ['needle']);
    expect(r.excerpt.length).toBeLessThanOrEqual(160);
    expect(r.excerpt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(marked(r)).toEqual(['needle']);
  });

  it('falls back to the start with no ranges when no hit is found', () => {
    const body = 'x'.repeat(300);
    const r = excerptOf(body, ['nothing']);
    expect(r).toEqual({ excerpt: 'x'.repeat(159) + '…', ranges: [] });
  });

  it('keeps at most 10 ranges', () => {
    expect(excerptOf('ab '.repeat(30), ['ab']).ranges).toHaveLength(10);
  });
});
