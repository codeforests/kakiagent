import { describe, expect, it } from 'vitest';
import { normaliseIdentity } from './identity.js';

describe('normaliseIdentity', () => {
  it('lower-cases email, writes SG phones as +65 and keeps Telegram digits', () => {
    expect(normaliseIdentity('email', ' Mei@Example.COM ')).toBe('mei@example.com');
    expect(normaliseIdentity('email', 'not an address')).toBeNull();
    expect(normaliseIdentity('phone', '9123 4567')).toBe('+6591234567');
    expect(normaliseIdentity('phone', '12345')).toBeNull();
    expect(normaliseIdentity('telegram', '424242')).toBe('424242');
    expect(normaliseIdentity('telegram', '@mei')).toBeNull();
  });
});
