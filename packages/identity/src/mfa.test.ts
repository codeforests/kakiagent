import { describe, expect, it } from 'vitest';
import {
  hashRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  RECOVERY_ALPHABET,
} from './recovery.js';
import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUri,
  TOTP_PERIOD_S,
  totpAt,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B, SHA-1 rows.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the Appendix B vector at T=%i', (t, code) => {
    const step = totpStep(new Date(t * 1000));
    expect(totpAt(RFC_SECRET, step, 8)).toBe(code);
    expect(totpAt(RFC_SECRET, step)).toBe(code.slice(2));
  });

  it('accepts the current step and one either side, refuses two away', () => {
    const now = new Date(1_800_000_000_000);
    const step = totpStep(now);
    for (const d of [-1, 0, 1])
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + d), now, null)).toEqual({
        ok: true,
        step: step + d,
      });
    for (const d of [-2, 2])
      expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + d), now, null)).toEqual({
        ok: false,
      });
  });

  it('refuses a step at or before the last one used (replay)', () => {
    const now = new Date(1_800_000_000_000);
    const step = totpStep(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, code, now, step + 1)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, code, now, step - 1).ok).toBe(true);
    const later = new Date(now.getTime() + TOTP_PERIOD_S * 1000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), later, step).ok).toBe(true);
  });

  it('refuses codes that are not six digits', () => {
    const now = new Date();
    for (const code of ['', '12345', '1234567', 'abcdef'])
      expect(verifyTotp(RFC_SECRET, code, now, null).ok).toBe(false);
  });

  it('round-trips base32 and matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
    const secret = newTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    expect(() => base32Decode('MZ1')).toThrow();
  });

  it('builds the otpauth URI authenticator apps read', () => {
    const secret = Buffer.from('foobar');
    expect(otpauthUri(secret, 'a+b@shop.test', 'Kaki Agent')).toBe(
      'otpauth://totp/Kaki%20Agent:a%2Bb%40shop.test?secret=MZXW6YTBOI&issuer=Kaki%20Agent&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('issues ten distinct xxxxx-xxxxx codes from the alphabet without look-alikes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const re = new RegExp(`^[${RECOVERY_ALPHABET}]{5}-[${RECOVERY_ALPHABET}]{5}$`);
    for (const c of codes) expect(c).toMatch(re);
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(RECOVERY_ALPHABET).not.toMatch(/[0o1i]/);
  });

  it('hashes the normalised code', () => {
    expect(normaliseRecoveryCode(' ABCDE-FGHIJ ')).toBe('abcdefghij');
    expect(hashRecoveryCode('ABCDE-FGHIJ')).toEqual(hashRecoveryCode('abcdefghij'));
    expect(hashRecoveryCode('abcde-fghij')).toHaveLength(32);
  });
});
