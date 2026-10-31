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
  AccountError,
  type AccountErrorCode,
  type InvitationErrorCode,
  type MfaStateCode,
  type TeamErrorCode,
} from './errors.js';
export {
  normaliseEmail,
  magicLinkEmail,
  inviteEmail,
  maskEmail,
  emailChangeConfirmEmail,
  emailChangeNoticeEmail,
  emailInUseEmail,
} from './email.js';
export {
  emailChangeToken,
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
  listSessions,
  revokeAllSessions,
  revokeOwnSession,
  revokeSession,
  type DeviceSessionView,
  type AuthContext,
  type AuthFailure,
  type AuthResult,
} from './sessions.js';
export {
  createWorkspace,
  listWorkspaces,
  switchWorkspace,
  workspaceSlug,
  type CreatedWorkspace,
  type WorkspaceView,
} from './workspaces.js';
export {
  listTeam,
  updateMember,
  type MemberPatch,
  type TeamMemberView,
  type TeamView,
} from './team.js';

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
export { deviceLabel } from './device.js';
export {
  cancelEmailChange,
  confirmEmailChange,
  emailChangeUrl,
  getAccount,
  requestEmailChange,
  sendEmailChange,
  sendPendingEmailChanges,
  updateProfile,
  type AccountView,
} from './account.js';
export { displayNameOf, inboxMembers, memberNames } from './names.js';
