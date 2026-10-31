import { describe, expect, it } from 'vitest';
import {
  Account,
  DeviceSessionList,
  EmailChangeBody,
  EmailChangeConfirmed,
  Me,
  ProfilePatch,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-31T01:00:00.000Z';

describe('my account contract (FEAT-008 §3)', () => {
  it('a display name is trimmed, 1 to 60 characters, without control characters', () => {
    expect(ProfilePatch.parse({ displayName: '  Mei Ling ' })).toEqual({ displayName: 'Mei Ling' });
    expect(ProfilePatch.parse({ displayName: null })).toEqual({ displayName: null });
    expect(ProfilePatch.parse({ displayName: 'x'.repeat(60) }).displayName).toHaveLength(60);
    for (const bad of ['', '   ', 'x'.repeat(61), 'Mei\nLing', 'Mei\tLing', 'Mei\u0085'])
      expect(ProfilePatch.safeParse({ displayName: bad }).success).toBe(false);
    expect(ProfilePatch.safeParse({}).success).toBe(false);
    expect(ProfilePatch.safeParse({ displayName: 'A', email: 'x@y.sg' }).success).toBe(false);
  });

  it('the new address is trimmed and lower-cased', () => {
    expect(EmailChangeBody.parse({ email: ' Mei@Example.COM ' })).toEqual({
      email: 'mei@example.com',
    });
    expect(EmailChangeBody.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('parses the account, the devices list, the confirmation and Me with a name', () => {
    expect(
      Account.parse({
        email: 'a@b.sg',
        displayName: null,
        googleLinked: false,
        pendingEmail: { email: 'c@d.sg', requestedAt: AT, expiresAt: AT, delivery: 'queued' },
      }).pendingEmail?.delivery,
    ).toBe('queued');
    expect(
      DeviceSessionList.parse({
        sessions: [
          {
            id: ID,
            device: 'Chrome on Windows',
            authMethod: 'google',
            signedInAt: AT,
            lastActiveAt: AT,
            current: true,
          },
        ],
      }).sessions,
    ).toHaveLength(1);
    expect(EmailChangeConfirmed.parse({ email: 'c@d.sg' }).email).toBe('c@d.sg');
    const me = { role: null, tenant: null, canApprove: false };
    expect(
      Me.safeParse({ ...me, user: { id: ID, email: 'a@b.sg', displayName: 'A' } }).success,
    ).toBe(true);
    expect(Me.safeParse({ ...me, user: { id: ID, email: 'a@b.sg' } }).success).toBe(false);
  });
});
