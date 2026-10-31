import { describe, expect, it } from 'vitest';
import {
  InvitationLookup,
  InviteBody,
  MagicLinkRequest,
  MemberPatch,
  Me,
  TeamResponse,
  WorkspaceList,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-31T01:00:00.000Z';

describe('team contract (FEAT-007 §3)', () => {
  it('parses a team with a member and an invitation', () => {
    const team = {
      members: [
        {
          userId: ID,
          email: 'a@b.sg',
          displayName: null,
          role: 'agent',
          status: 'active',
          approvalRights: true,
          mfaEnrolled: false,
          joinedAt: AT,
          lastActiveAt: null,
          you: false,
        },
      ],
      invitations: [
        {
          id: ID,
          email: 'c@d.sg',
          role: 'admin',
          invitedBy: 'a@b.sg',
          createdAt: AT,
          expiresAt: AT,
          state: 'expired',
          delivery: 'queued',
        },
      ],
    };
    expect(TeamResponse.parse(team)).toEqual(team);
  });

  it('invites only as Admin or Agent, with a normalised address', () => {
    expect(InviteBody.parse({ email: ' New@Shop.SG ', role: 'agent' }).email).toBe('new@shop.sg');
    expect(InviteBody.safeParse({ email: 'a@b.sg', role: 'owner' }).success).toBe(false);
  });

  it('a member patch carries exactly one change', () => {
    expect(MemberPatch.parse({ role: 'admin' })).toEqual({ role: 'admin' });
    expect(MemberPatch.parse({ approvalRights: false })).toEqual({ approvalRights: false });
    expect(MemberPatch.safeParse({ role: 'admin', status: 'active' }).success).toBe(false);
    expect(MemberPatch.safeParse({ role: 'owner' }).success).toBe(false);
    expect(MemberPatch.safeParse({}).success).toBe(false);
  });

  it('parses the lookup, workspaces, Me.canApprove and the magic link with an invitation', () => {
    expect(
      InvitationLookup.parse({
        state: 'valid',
        tenantName: 'Kaki Bakery',
        role: 'agent',
        email: 'a@b.sg',
        invitedBy: 'o@b.sg',
        signedInAs: null,
      }).state,
    ).toBe('valid');
    expect(
      WorkspaceList.parse({ workspaces: [{ id: ID, name: 'X', role: 'owner', current: true }] })
        .workspaces,
    ).toHaveLength(1);
    expect(
      Me.safeParse({ user: { id: ID, email: 'a@b.sg' }, role: null, tenant: null }).success,
    ).toBe(false);
    expect(MagicLinkRequest.parse({ email: 'a@b.sg', invitation: 't' }).invitation).toBe('t');
  });
});
