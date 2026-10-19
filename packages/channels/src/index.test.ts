import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './index.js';

describe('isAllowedOrigin (CHN-11)', () => {
  const allowed = ['https://bakery.sg', 'http://localhost:5175'];

  it('accepts exact origins, ignoring a trailing slash', () => {
    expect(isAllowedOrigin('https://bakery.sg', allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5175/', allowed)).toBe(true);
  });

  it('rejects other schemes, ports, hosts and garbage', () => {
    expect(isAllowedOrigin('http://bakery.sg', allowed)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5176', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evil.bakery.sg', allowed)).toBe(false);
    expect(isAllowedOrigin('not a url', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin('https://bakery.sg', ['::bad::'])).toBe(false);
  });
});
