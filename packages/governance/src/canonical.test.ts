import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const keys = JSON.parse(
      `[${canonicalJson(input)
        .slice(1, -1)
        .split(/,(?=")/)
        .map((p) => p.slice(0, p.indexOf('":') + 1))
        .join(',')}]`,
    );
    expect(keys).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
  });

  it('serialises numbers the ECMAScript way', () => {
    expect(canonicalJson([1e21, 0.000001, 1e-7, -0, 333333333.3333333, 4.5, 2 ** 53])).toBe(
      '[1e+21,0.000001,1e-7,0,333333333.3333333,4.5,9007199254740992]',
    );
  });

  it('escapes strings minimally, with lowercase hex for controls', () => {
    expect(canonicalJson('\u000f€"\\\n')).toBe('"\\u000f€\\"\\\\\\n"');
  });

  it('has no whitespace and recurses into arrays and objects', () => {
    expect(canonicalJson({ b: [true, null, { d: 1, c: 'x' }], a: {} })).toBe(
      '{"a":{},"b":[true,null,{"c":"x","d":1}]}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['undefined member', { a: undefined }],
    ['a Date', new Date(0)],
    ['a function', () => 1],
    ['a bigint', 1n],
  ])('rejects %s', (_n, v) => {
    expect(() => canonicalJson(v)).toThrow(TypeError);
  });
});
