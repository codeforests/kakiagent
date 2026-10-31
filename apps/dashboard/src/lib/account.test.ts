import type { DeviceSession } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  accountErrorText,
  activeText,
  confirmFailure,
  deviceDetail,
  deviceIcon,
  nameError,
  nameValue,
} from './account.ts';
import { ApiError } from './api.ts';

const apiError = (status: number, code: string) => new ApiError(status, code, code);

describe('nameError and nameValue', () => {
  it('accepts names of 1 to 60 characters, including CJK, and an empty field that clears', () => {
    for (const ok of ['Mei Ling', 'Tan Ah Kow', '陈美玲', 'a'.repeat(60), '', '   '])
      expect(nameError(ok)).toBeNull();
    expect(nameValue('  Mei Ling ')).toBe('Mei Ling');
    expect(nameValue('  ')).toBeNull();
  });

  it('refuses a name over 60 characters or with control characters', () => {
    for (const bad of ['a'.repeat(61), 'Mei\tLing', 'Mei\nLing'])
      expect(nameError(bad)).toBe('Use up to 60 letters, numbers and spaces.');
  });
});

describe('accountErrorText', () => {
  it('maps the email-change codes to the ui-design wording', () => {
    expect(accountErrorText(apiError(409, 'same_email'))).toEqual({
      text: "That's already your email address.",
      field: true,
    });
    expect(accountErrorText(apiError(400, 'validation')).field).toBe(true);
    expect(accountErrorText(apiError(429, 'rate_limited'))).toEqual({
      text: 'Too many changes. Try again in an hour.',
      field: false,
    });
    expect(accountErrorText(new TypeError('offline')).field).toBe(false);
  });
});

describe('confirmFailure', () => {
  it('maps each confirm error to its state, anything else to error', () => {
    expect(confirmFailure(apiError(400, 'link_expired'))).toBe('expired');
    expect(confirmFailure(apiError(400, 'link_used'))).toBe('used');
    expect(confirmFailure(apiError(400, 'link_invalid'))).toBe('invalid');
    expect(confirmFailure(apiError(409, 'email_taken'))).toBe('taken');
    expect(confirmFailure(apiError(429, 'rate_limited'))).toBe('error');
    expect(confirmFailure(apiError(500, 'error'))).toBe('error');
  });
});

describe('devices', () => {
  const now = new Date('2026-11-05T14:00:00+08:00');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('gives phones and tablets the smartphone icon', () => {
    expect(deviceIcon('Safari on iPhone')).toBe('smartphone');
    expect(deviceIcon('Safari on iPad')).toBe('smartphone');
    expect(deviceIcon('Chrome on Android')).toBe('smartphone');
    expect(deviceIcon('Chrome on Windows')).toBe('monitor');
    expect(deviceIcon('Unknown device')).toBe('monitor');
  });

  it('says now, minutes ago, today or the date for last activity', () => {
    expect(activeText(ago(60_000), now)).toBe('now');
    expect(activeText(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(activeText(ago(3 * 3_600_000), now)).toMatch(/^today \d\d:\d\d$/);
    expect(activeText('2026-11-01T10:00:00+08:00', now)).toBe('1 Nov');
    expect(activeText('2025-11-01T10:00:00+08:00', now)).toBe('1 Nov 2025');
  });

  it('describes a device by sign-in date, method and activity', () => {
    const s: DeviceSession = {
      id: '00000000-0000-4000-8000-000000000001',
      device: 'Chrome on Windows',
      authMethod: 'google',
      signedInAt: '2026-11-03T10:00:00+08:00',
      lastActiveAt: ago(30_000),
      current: false,
    };
    expect(deviceDetail(s, now)).toBe('Signed in 3 Nov with Google · Active now');
    expect(deviceDetail({ ...s, authMethod: 'magic_link' }, now)).toContain('with email link');
  });
});
