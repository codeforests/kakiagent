export { can, canApprove, type Role, type Capability } from './capabilities.js';
export {
  CURRENT_TERMS,
  TERMS_DOCUMENTS,
  termsAccepted,
  termsAreCurrent,
  type TermsDocument,
} from './terms.js';
export {
  GoogleSignInError,
  InvitationError,
  LinkError,
  MfaChallengeError,
  MfaCodeError,
  MfaEnrolmentError,
  MfaLockedError,
  MfaRateLimitError,
  MfaStateError,
  NotMemberError,
  TeamError,
  TermsOutdatedError,
  type InvitationErrorCode,
  type MfaStateCode,
  type TeamErrorCode,
} from './errors.js';
export { normaliseEmail, magicLinkEmail, inviteEmail } from './email.js';
export {
  hashToken,
  inviteToken,
  isTokenShaped,
  magicLinkToken,
  newSessionToken,
} from './tokens.js';
export {
  acceptInvitation,
  createInvitation,
  inviteUrl,
  listInvitations,
  lookupInvitation,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
  sendPendingInvitations,
  type InvitableRole,
  type InvitationLookupView,
  type InvitationView,
  type TeamActor,
} from './invitations.js';
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
