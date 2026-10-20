/** A magic link that can't sign anyone in (AUTH-01): 400 with the code. */
export class LinkError extends Error {
  override name = 'LinkError';
  constructor(readonly code: 'link_expired' | 'link_used' | 'link_invalid') {
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
