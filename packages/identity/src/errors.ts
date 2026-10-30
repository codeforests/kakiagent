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
