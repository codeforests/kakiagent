import { describe, expect, it } from 'vitest';
import { InvalidOriginError, normaliseOrigin } from './origin.js';

const dev = { allowLocalhost: true };
const prod = { allowLocalhost: false };

describe('normaliseOrigin (FEAT-032 §3, D3)', () => {
  it('turns a bare host or a URL into https://host[:port]', () => {
    expect(normaliseOrigin('bakery.sg', prod)).toBe('https://bakery.sg');
    expect(normaliseOrigin('https://www.Bakery.SG/menu?x=1#top', prod)).toBe(
      'https://www.bakery.sg',
    );
    expect(normaliseOrigin('  WWW.BAKERY.SG.  ', prod)).toBe('https://www.bakery.sg');
    expect(normaliseOrigin('https://shop.bakery.sg:8443/', prod)).toBe(
      'https://shop.bakery.sg:8443',
    );
    expect(normaliseOrigin('https://bakery.sg:443', prod)).toBe('https://bakery.sg');
  });

  it('rejects wildcards, IPs, user info, hosts without a dot and other schemes', () => {
    for (const bad of [
      '*.myshopify.com',
      'https://*.bakery.sg',
      '203.0.113.7',
      'https://203.0.113.7',
      'https://[::1]',
      'bakery',
      'https://user:pw@bakery.sg',
      'ftp://bakery.sg',
      'javascript:alert(1)',
      '',
      'http://bakery.sg',
    ]) {
      expect(() => normaliseOrigin(bad, dev), bad).toThrow(InvalidOriginError);
    }
  });

  it('allows http://localhost only outside production builds', () => {
    expect(normaliseOrigin('http://localhost:5175/host.html', dev)).toBe('http://localhost:5175');
    expect(() => normaliseOrigin('http://localhost:5175', prod)).toThrow(InvalidOriginError);
    expect(() => normaliseOrigin('http://127.0.0.1:5175', dev)).toThrow(InvalidOriginError);
  });
});
