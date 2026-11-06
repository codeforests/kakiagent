import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_ERRORS,
  ApprovalLinkBody,
  ApprovalLinkOpened,
  MagicLinkRequest,
  MagicLinkVerifyResponse,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('approval link contracts (FEAT-056 §3)', () => {
  it('round-trips every open state', () => {
    for (const v of [
      { state: 'opened', approvalId: ID, switched: false },
      { state: 'sign_in' },
      { state: 'two_step' },
      { state: 'two_step_setup' },
    ]) {
      expect(ApprovalLinkOpened.parse(v)).toEqual(v);
    }
  });

  it('refuses opened without an approval ID', () => {
    expect(ApprovalLinkOpened.safeParse({ state: 'opened', switched: false }).success).toBe(false);
    expect(ApprovalLinkOpened.safeParse({ state: 'other' }).success).toBe(false);
  });

  it('bounds the token', () => {
    expect(ApprovalLinkBody.safeParse({ token: 'a'.repeat(1000) }).success).toBe(true);
    expect(ApprovalLinkBody.safeParse({ token: 'a'.repeat(1001) }).success).toBe(false);
    expect(ApprovalLinkBody.safeParse({ token: '' }).success).toBe(false);
  });

  it('carries the approval link through a sign-in link', () => {
    expect(MagicLinkRequest.parse({ email: 'A@B.test', approvalLink: 'tok' })).toEqual({
      email: 'a@b.test',
      approvalLink: 'tok',
    });
    expect(
      MagicLinkRequest.safeParse({ email: 'a@b.test', approvalLink: 'a'.repeat(1001) }).success,
    ).toBe(false);
    expect(MagicLinkVerifyResponse.parse({ next: 'app', approvalLink: 'tok' })).toEqual({
      next: 'app',
      approvalLink: 'tok',
    });
    expect(MagicLinkVerifyResponse.parse({ next: 'app' })).toEqual({ next: 'app' });
  });

  it('maps every error to its status', () => {
    expect(APPROVAL_LINK_ERRORS).toEqual({
      link_invalid: 400,
      link_expired: 410,
      link_used: 409,
      wrong_account: 403,
      not_member: 403,
    });
  });
});
