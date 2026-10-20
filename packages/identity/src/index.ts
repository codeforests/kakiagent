export { can, type Role, type Capability } from './capabilities.js';
export { CURRENT_TERMS, TERMS_DOCUMENTS, termsAreCurrent, type TermsDocument } from './terms.js';
export { LinkError, GoogleSignInError, TermsOutdatedError } from './errors.js';
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
