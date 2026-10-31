export { can, type Role, type Capability } from './capabilities.js';
export {
  CURRENT_TERMS,
  TERMS_DOCUMENTS,
  termsAccepted,
  termsAreCurrent,
  type TermsDocument,
} from './terms.js';
export {
  GoogleSignInError,
  LinkError,
  MfaChallengeError,
  MfaCodeError,
  MfaEnrolmentError,
  MfaLockedError,
  MfaRateLimitError,
  MfaStateError,
  TermsOutdatedError,
  type MfaStateCode,
} from './errors.js';
export { normaliseEmail, magicLinkEmail } from './email.js';
export { hashToken, isTokenShaped, magicLinkToken, newSessionToken } from './tokens.js';
export {
  backoffSeconds,
  consumeMagicLink,
  magicLinkUrl,
  requestMagicLink,
  sendMagicLink,
  sendPendingMagicLinks,
  type MagicLinkConfig,
  type Reauthed,
} from './magic-link.js';
export { findOrCreateUser, startSession, type SignedIn } from './users.js';
export {
  authenticate,
  revokeAllSessions,
  revokeSession,
  type AuthContext,
  type AuthFailure,
  type AuthResult,
} from './sessions.js';
export { createWorkspace, workspaceSlug, type CreatedWorkspace } from './workspaces.js';

/** The session cookie (ADR-020): opaque token, HttpOnly, SameSite=Lax. */
export const SESSION_COOKIE = 'kaki_session';
export {
  createGoogleSignIn,
  signInWithGoogle,
  OAUTH_COOKIE,
  OAUTH_COOKIE_TTL_S,
  type GoogleConfig,
  type GoogleSignIn,
} from './google.js';
export {
  confirmEnrolment,
  MFA_MAX_ATTEMPTS,
  mfaStatus,
  passChallenge,
  reauthenticate,
  reauthStatus,
  regenerateRecoveryCodes,
  removeFactor,
  requestReauthLink,
  startEnrolment,
  type MfaCodeInput,
  type MfaDeps,
  type MfaStatusView,
  type ReauthStatusView,
} from './mfa.js';
export {
  REAUTH_WINDOW_MINUTES,
  ReauthRequiredError,
  reauthMethods,
  requireReauth,
  type ReauthMethod,
} from './reauth.js';
export { base32Decode, otpauthUri, totpAt, totpStep } from './totp.js';
