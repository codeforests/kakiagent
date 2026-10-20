import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardPrefixOk, findPii, luhnOk, maskLogText, nricChecksumOk, piiMask } from './pii-mask.js';

interface CorpusCase {
  id: string;
  text: string;
  masked: string;
}
const corpus = (
  JSON.parse(readFileSync(new URL('./pii-corpus.json', import.meta.url), 'utf8')) as {
    cases: CorpusCase[];
  }
).cases;

describe('piiMask corpus (GOV-04, FEAT-003 AC-1–AC-4)', () => {
  it.each(corpus.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(piiMask(c.text)).toBe(c.masked);
  });

  it.each(corpus.map((c) => [c.id, c] as const))('%s is idempotent', (_id, c) => {
    expect(piiMask(piiMask(c.text))).toBe(piiMask(c.text));
  });

  it('has both positive and negative cases', () => {
    expect(corpus.filter((c) => c.text !== c.masked).length).toBeGreaterThan(30);
    expect(corpus.filter((c) => c.text === c.masked).length).toBeGreaterThan(20);
  });
});

describe('checksums', () => {
  it('validates NRIC/FIN check letters for every prefix', () => {
    for (const v of ['S1234567D', 'T1234567J', 'F1234567N', 'G1234567X', 'M1234567K', 'M1235467X'])
      expect(nricChecksumOk(v[0]!, v.slice(1, 8), v[8]!), v).toBe(true);
    expect(nricChecksumOk('S', '1234567', 'A')).toBe(false);
    expect(nricChecksumOk('X', '1234567', 'D')).toBe(false);
    expect(nricChecksumOk('S', '123456', 'D')).toBe(false);
  });
  it('accepts only issued card prefixes (D13)', () => {
    expect(cardPrefixOk(4, 13)).toBe(true);
    expect(cardPrefixOk(5, 13)).toBe(false);
    for (const d of [2, 3, 4, 5, 6]) expect(cardPrefixOk(d, 16)).toBe(true);
    for (const d of [0, 1, 7, 8, 9]) expect(cardPrefixOk(d, 16)).toBe(false);
  });
  it('validates Luhn', () => {
    expect(luhnOk('4242424242424242')).toBe(true);
    expect(luhnOk('378282246310005')).toBe(true);
    expect(luhnOk('4242424242424241')).toBe(false);
  });
});

describe('findPii', () => {
  it('reports kinds and offsets in order', () => {
    const text = 'IC S1234567D, card 4242 4242 4242 4242, DBS acct 123-456789-0';
    const found = findPii(text);
    expect(found.map((f) => f.kind)).toEqual(['nric', 'card', 'bank']);
    expect(found.map((f) => text.slice(f.start, f.end))).toEqual([
      'S1234567D',
      '4242 4242 4242 4242',
      '123-456789-0',
    ]);
  });
});

describe('maskLogText (AC-7)', () => {
  it('masks identifiers, emails and SG phone numbers', () => {
    expect(
      maskLogText('S1234567D tan@example.com 9123 4567 +65 6123 4567 card 4242424242424242'),
    ).toBe('[NRIC ••••567D] [EMAIL] [PHONE] [PHONE] card [CARD ••••4242]');
  });
  it('leaves IDs and counts alone', () => {
    const line = 'turn 3f2b1c9e-0000-4000-8000-000000000001 took 120 ms, 3 facts';
    expect(maskLogText(line)).toBe(line);
  });
});

/**
 * CPU time of this process in ms. Wall time on a shared CI runner measures how long the
 * test waited for a core, not the masker (FEAT-003 D14).
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

describe('performance (AC-10)', () => {
  it('masks a 4000-character adversarial message in under 20 ms of CPU time', () => {
    const inputs = [
      '1 2 3 4 5 6 7 8 9 0 '.repeat(200),
      'S123456 '.repeat(500),
      'account 1234-5678-9 '.repeat(200),
      '4242-'.repeat(800),
      'S-1-2-3-4-5-6-7-'.repeat(250),
    ].map((s) => s.slice(0, 4000));
    for (const input of inputs) {
      const times = Array.from({ length: 5 }, () => {
        const t = cpuMs();
        piiMask(input);
        return cpuMs() - t;
      });
      expect(Math.min(...times), input.slice(0, 20)).toBeLessThan(20);
    }
  });
});

describe('maskLogText performance (M3)', () => {
  it('stays linear on long strings with and without an @', () => {
    for (const input of ['a@' + 'a'.repeat(16_000), 'a.'.repeat(8_000) + '@', 'a@'.repeat(8_000)]) {
      const times = Array.from({ length: 3 }, () => {
        const t = cpuMs();
        maskLogText(input);
        return cpuMs() - t;
      });
      expect(Math.min(...times), input.slice(0, 10)).toBeLessThan(20);
    }
  });

  it('replaces many phone numbers in one pass (re-verification M4)', () => {
    const input = 'call 91234567 '.repeat(9_400); // about 128,000 characters
    const times = Array.from({ length: 3 }, () => {
      const t = cpuMs();
      maskLogText(input);
      return cpuMs() - t;
    });
    expect(Math.min(...times)).toBeLessThan(100);
  });
});

describe('random inputs', () => {
  // A small seeded generator, so a failure reproduces.
  let seed = 20261020;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    // The high bits: an LCG's low bits repeat with a short period.
    return Math.floor((seed / 2 ** 31) * n);
  };
  const alphabet = '0123456789     --STFGMDJabc户口账号+.\u3000\u00a0\u2013\t';
  const inputs = Array.from({ length: 2000 }, () =>
    Array.from({ length: 10 + rand(60) }, () => alphabet[rand(alphabet.length)]).join(''),
  );

  it('is idempotent', () => {
    for (const s of inputs) expect(piiMask(piiMask(s)), s).toBe(piiMask(s));
  });

  it('is idempotent when identifiers touch each other (D17, M12)', () => {
    const parts = [
      'S1234567D',
      'T1234567J',
      '4242424242424242',
      '1234567890',
      'acct ',
      ' ',
      '-',
      'x',
    ];
    for (let n = 0; n < 2000; n++) {
      const s = Array.from({ length: 2 + rand(5) }, () => parts[rand(parts.length)]).join('');
      expect(piiMask(piiMask(s)), s).toBe(piiMask(s));
    }
  });

  it('leaves no checksum-valid NRIC and no 16-digit card behind', () => {
    for (const s of inputs) {
      const out = piiMask(s);
      for (const m of out.matchAll(/(?<![A-Za-z0-9])([STFGM])(\d{7})([A-Z])(?![A-Za-z0-9])/gi))
        expect(nricChecksumOk(m[1]!, m[2]!, m[3]!), s).toBe(false);
      for (const m of out.matchAll(/(?<![A-Za-z0-9])\d{16}(?![A-Za-z0-9])/g))
        expect(luhnOk(m[0]) && cardPrefixOk(Number(m[0][0]), 16), s).toBe(false);
    }
  });
});
