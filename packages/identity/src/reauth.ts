/**
 * AUTH-03's re-authentication window (ADR-020; FEAT-006 §5.2): sensitive actions need a
 * fresh authentication of this session in the last 10 minutes. This is the
 * `identity.requireReauth` block the plan names; each sensitive action's feature calls it
 * (D9).
 */
export const REAUTH_WINDOW_MINUTES = 10;

export type ReauthMethod = 'totp' | 'recovery' | 'email';

/** The ways this user can re-authenticate (D4): the second factor when enrolled, else email. */
export const reauthMethods = (mfaEnrolled: boolean): ReauthMethod[] =>
  mfaEnrolled ? ['totp', 'recovery'] : ['email'];

/** 403 `reauth_required` with the user's methods. */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
  constructor(readonly methods: ReauthMethod[]) {
    super('reauth_required');
  }
}

/** Throws unless the session re-authenticated in the last 10 minutes. */
export function requireReauth(auth: { reauthFresh: boolean; mfaEnrolled: boolean }): void {
  if (!auth.reauthFresh) throw new ReauthRequiredError(reauthMethods(auth.mfaEnrolled));
}
