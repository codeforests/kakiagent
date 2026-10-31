import type { Role, TeamMember } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import { inviteErrorText, lastActiveText, memberActions, roleLabel, withArticle } from './team.ts';

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'staff@kaki-bakery.test',
  displayName: null,
  role: 'agent',
  status: 'active',
  approvalRights: false,
  mfaEnrolled: false,
  joinedAt: '2026-10-01T02:00:00.000Z',
  lastActiveAt: null,
  you: false,
  ...over,
});

describe('memberActions', () => {
  const roles: Role[] = ['owner', 'admin', 'agent'];

  it('gives the Owner row and your own row nothing, whoever is looking', () => {
    for (const viewer of roles) {
      expect(memberActions(viewer, member({ role: 'owner' }))).toEqual([]);
      for (const role of roles)
        expect(memberActions(viewer, member({ role, you: true }))).toEqual([]);
    }
  });

  it('gives an Agent viewer, or no role, nothing on any row', () => {
    for (const viewer of ['agent', null, undefined] as const)
      for (const role of ['admin', 'agent'] as const)
        for (const status of ['active', 'deactivated'] as const)
          expect(memberActions(viewer, member({ role, status }))).toEqual([]);
  });

  it('lets the Owner change, grant rights to and deactivate an active Agent', () => {
    expect(memberActions('owner', member())).toEqual(['change_role', 'grant_rights', 'deactivate']);
    expect(memberActions('owner', member({ approvalRights: true }))).toEqual([
      'change_role',
      'remove_rights',
      'deactivate',
    ]);
  });

  it('gives rights only to the Owner and only on active Agents', () => {
    expect(memberActions('admin', member())).toEqual(['change_role', 'deactivate']);
    expect(memberActions('admin', member({ approvalRights: true }))).toEqual([
      'change_role',
      'deactivate',
    ]);
    expect(memberActions('owner', member({ role: 'admin' }))).toEqual([
      'change_role',
      'deactivate',
    ]);
    expect(memberActions('admin', member({ role: 'admin' }))).toEqual([
      'change_role',
      'deactivate',
    ]);
  });

  it('only reactivates a deactivated member', () => {
    for (const viewer of ['owner', 'admin'] as const)
      for (const role of ['admin', 'agent'] as const)
        expect(memberActions(viewer, member({ role, status: 'deactivated' }))).toEqual([
          'reactivate',
        ]);
  });
});

describe('inviteErrorText', () => {
  const email = 'staff@kaki-bakery.test';
  const err = (code: string, status = 409) => new ApiError(status, code, 'server text');

  it('names each invite error with the address and the way out', () => {
    expect(inviteErrorText(err('already_member'), email)).toEqual({
      text: 'staff@kaki-bakery.test is already in your team.',
    });
    expect(inviteErrorText(err('member_deactivated'), email)).toEqual({
      text: 'staff@kaki-bakery.test was deactivated.',
      link: 'reactivate',
    });
    expect(inviteErrorText(err('invite_pending'), email)).toEqual({
      text: "There's already an invitation for staff@kaki-bakery.test.",
      link: 'resend',
    });
    expect(inviteErrorText(err('rate_limited', 429), email)).toEqual({
      text: "You've sent a lot of invitations. Try again in an hour.",
    });
  });

  it('falls back to a retry line for anything else', () => {
    expect(inviteErrorText(err('error', 500), email).text).toBe("That didn't save. Try again.");
    expect(inviteErrorText(new TypeError('fetch failed'), email).text).toBe(
      "That didn't save. Try again.",
    );
  });
});

describe('labels', () => {
  it('names roles with their article', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(withArticle('admin')).toBe('an Admin');
    expect(withArticle('agent')).toBe('an Agent');
  });

  it('shows last activity as today, a date, or never', () => {
    const now = new Date(2026, 9, 31, 16, 0);
    expect(lastActiveText(null, now)).toBe('Never');
    expect(lastActiveText(new Date(2026, 9, 31, 14, 2).toISOString(), now)).toBe('Today 14:02');
    expect(lastActiveText(new Date(2026, 9, 3, 9, 0).toISOString(), now)).toBe('3 Oct');
    expect(lastActiveText(new Date(2025, 9, 3, 9, 0).toISOString(), now)).toBe('3 Oct 2025');
  });
});
