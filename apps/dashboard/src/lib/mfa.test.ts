import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  attemptsLeft,
  clockTime,
  codeFormatError,
  dayDate,
  formatKey,
  formatRecoveryCode,
  isTotpCode,
  lockedUntil,
  normaliseCode,
  recoveryCodesFile,
  safeNext,
  TOTP_FORMAT,
  TOTP_WRONG,
  wrongCodeText,
} from './mfa.ts';

describe('codes', () => {
  it('ignores spaces and hyphens', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456');
    expect(normaliseCode('ABCDE-fghij')).toBe('abcdefghij');
  });
  it('accepts six digits only as an app code', () => {
    expect(isTotpCode('123 456')).toBe(true);
    expect(isTotpCode('12345')).toBe(false);
    expect(isTotpCode('12345a')).toBe(false);
  });
  it('formats recovery codes and keys', () => {
    expect(formatRecoveryCode('abcdefghjk')).toBe('abcde-fghjk');
    expect(formatRecoveryCode('ABCDE FGHJK')).toBe('abcde-fghjk');
    expect(formatKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(formatKey('ABCDEF')).toBe('ABCD EF');
  });
  it('writes the download file with every code', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `aaaaa-bbbb${'abcdefghjk'[i]}`);
    const text = recoveryCodesFile(codes, 'owner@example.sg');
    expect(text).toContain('KakiAgent recovery codes for owner@example.sg');
    for (const c of codes) expect(text).toContain(c);
  });
});

describe('error details', () => {
  it('reads attemptsLeft and until', () => {
    expect(attemptsLeft(new ApiError(400, 'code_invalid', 'x', { attemptsLeft: 2 }))).toBe(2);
    expect(attemptsLeft(new ApiError(400, 'code_invalid', 'x'))).toBeNull();
    const until = '2026-10-30T06:20:00.000Z';
    expect(lockedUntil(new ApiError(429, 'mfa_locked', 'x', { until }))).toBe(until);
    expect(lockedUntil(new ApiError(429, 'too_many_attempts', 'x'))).toBeNull();
  });
});

describe('dates (SGT)', () => {
  it('formats the lock time and enrolment day', () => {
    expect(clockTime('2026-10-30T06:20:00.000Z')).toBe('2:20 pm');
    expect(dayDate('2026-10-29T17:00:00.000Z')).toBe('30 Oct 2026');
  });
});

describe('safeNext', () => {
  it('keeps same-origin paths only', () => {
    expect(safeNext('/knowledge?x=1')).toBe('/knowledge?x=1');
    expect(safeNext('//evil.example')).toBe('/inbox');
    expect(safeNext('/\\evil.example')).toBe('/inbox');
    expect(safeNext('https://evil.example')).toBe('/inbox');
    expect(safeNext(null)).toBe('/inbox');
  });
});

describe('code field texts', () => {
  it('validates the format on submit', () => {
    expect(codeFormatError('totp', '12345')).toBe(TOTP_FORMAT);
    expect(codeFormatError('totp', '123 456')).toBeNull();
    expect(codeFormatError('recovery', 'abcde-fghjk')).toBeNull();
    expect(codeFormatError('recovery', 'abc')).not.toBeNull();
  });
  it('adds the tries left only when two or fewer remain', () => {
    const wrong = (n: number) => new ApiError(400, 'code_invalid', 'x', { attemptsLeft: n });
    expect(wrongCodeText('totp', wrong(4))).toBe(TOTP_WRONG);
    expect(wrongCodeText('totp', wrong(2))).toBe(`${TOTP_WRONG} 2 tries left.`);
    expect(wrongCodeText('totp', wrong(1))).toBe(`${TOTP_WRONG} 1 try left.`);
    expect(wrongCodeText('recovery', wrong(1))).toMatch(/^That recovery code didn't work/);
    expect(wrongCodeText('totp', new ApiError(429, 'mfa_locked', 'x'))).toBeNull();
  });
});
