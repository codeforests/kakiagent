import { describe, expect, it } from 'vitest';
import {
  MagicLinkVerifyResponse,
  MfaCode,
  MfaStatus,
  RecoveryCodes,
  ReauthRequired,
  TeamMfa,
} from './index.js';

describe('two-step contract (FEAT-006 §3)', () => {
  it('parses a status, a code and the reauth_required error', () => {
    const status = {
      state: 'challenge',
      enrolled: true,
      enrolledAt: '2026-10-28T05:00:00.000Z',
      recoveryCodesLeft: 9,
      requiredBy: [{ tenantId: '00000000-0000-4000-8000-000000000001', name: 'Kaki Bakery' }],
      lockedUntil: null,
      email: 'a@b.sg',
    };
    expect(MfaStatus.parse(status)).toEqual(status);
    expect(MfaCode.parse({ method: 'totp', code: ' 123456 ' }).code).toBe('123456');
    expect(
      ReauthRequired.parse({ error: 'reauth_required', message: 'x', methods: ['email'] }),
    ).toMatchObject({ methods: ['email'] });
    expect(TeamMfa.parse({ required: true, members: 3, enrolled: 1 }).enrolled).toBe(1);
    for (const next of ['mfa', 'mfa-enrol', 'reauthed'])
      expect(MagicLinkVerifyResponse.parse({ next }).next).toBe(next);
  });

  it('rejects an unknown state or method, empty methods and nine codes', () => {
    expect(() => MfaCode.parse({ method: 'sms', code: '1' })).toThrow();
    expect(() =>
      ReauthRequired.parse({ error: 'reauth_required', message: 'x', methods: [] }),
    ).toThrow();
    expect(() => RecoveryCodes.parse({ codes: Array(9).fill('a') })).toThrow();
    expect(() => TeamMfa.parse({ required: true, members: -1, enrolled: 0 })).toThrow();
  });
});
