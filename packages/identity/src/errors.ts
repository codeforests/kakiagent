/** A magic link that can't sign anyone in (AUTH-01): 400 with the code. */
export class LinkError extends Error {
  override name = 'LinkError';
  constructor(readonly code: 'link_expired' | 'link_used' | 'link_invalid' | 'link_other_session') {
    super(code);
  }
}

/** A Google sign-in that failed any check (FEAT-005 §3.3). */
export class GoogleSignInError extends Error {
  override name = 'GoogleSignInError';
}

/** The accepted versions are not the current ones (AUTH-08): 409 `terms_outdated`. */
export class TermsOutdatedError extends Error {
  override name = 'TermsOutdatedError';
}

/** The session must pass the code challenge first (FEAT-006 §5.3): 401 `mfa_required`. */
export class MfaChallengeError extends Error {
  override name = 'MfaChallengeError';
}

/** The workspace requires two-step verification and the user has none: 403 `mfa_enrolment_required`. */
export class MfaEnrolmentError extends Error {
  override name = 'MfaEnrolmentError';
}

/** A wrong or malformed code: 400 `code_invalid`; `attemptsLeft` only for a TOTP challenge. */
export class MfaCodeError extends Error {
  override name = 'MfaCodeError';
  constructor(readonly attemptsLeft?: number) {
    super('code_invalid');
  }
}

/** Five wrong codes in a row lock the TOTP challenge (UC-02 3c): 429 `mfa_locked`. */
export class MfaLockedError extends Error {
  override name = 'MfaLockedError';
  constructor(readonly until: Date) {
    super('mfa_locked');
  }
}

/** Too many recovery or enrolment codes in 15 minutes: 429 `too_many_attempts`. */
export class MfaRateLimitError extends Error {
  override name = 'MfaRateLimitError';
}

export type MfaStateCode =
  | 'mfa_already_enrolled'
  | 'mfa_not_enrolled'
  | 'no_enrolment'
  | 'mfa_required_by_workspace'
  | 'use_authenticator';

/** The request doesn't fit the user's two-step state: 409 with the code (`no_enrolment` is 404). */
export class MfaStateError extends Error {
  override name = 'MfaStateError';
  constructor(
    readonly code: MfaStateCode,
    readonly workspaces?: string[],
  ) {
    super(code);
  }
}

export type InvitationErrorCode =
  | 'already_member'
  | 'member_deactivated'
  | 'invite_pending'
  | 'invite_wrong_email'
  | 'not_found'
  | 'link_expired'
  | 'link_used'
  | 'link_invalid';

/** An invitation that can't be made, sent or accepted (FEAT-007 §3); the API maps the code. */
export class InvitationError extends Error {
  override name = 'InvitationError';
  constructor(readonly code: InvitationErrorCode) {
    super(code);
  }
}

export type TeamErrorCode =
  | 'owner_protected'
  | 'self_change'
  | 'not_agent'
  | 'member_deactivated'
  | 'forbidden'
  | 'not_found';

/** A member change the guards refuse (FEAT-007 §3, D3). */
export class TeamError extends Error {
  override name = 'TeamError';
  constructor(readonly code: TeamErrorCode) {
    super(code);
  }
}

/** No active membership in the workspace asked for (FEAT-007 §3): 404. */
export class NotMemberError extends Error {
  override name = 'NotMemberError';
}

export type AccountErrorCode = 'same_email' | 'email_taken' | 'current_session' | 'not_found';

/** A My account change that can't be made (FEAT-008 §3); the API maps the code. */
export class AccountError extends Error {
  override name = 'AccountError';
  constructor(readonly code: AccountErrorCode) {
    super(code);
  }
}
