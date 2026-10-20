import { sql, type ZoneDb } from '@kaki/db';
import { signToken, verifyToken } from '@kaki/platform';
import * as oidc from 'openid-client';
import { normaliseEmail } from './email.js';
import { GoogleSignInError } from './errors.js';
import { findOrCreateUser, startSession, type SignedIn } from './users.js';

export interface GoogleConfig {
  /** `https://accounts.google.com`, or a local provider in tests. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `{PUBLIC_APP_URL}/api/v1/auth/google/callback`. */
  redirectUri: string;
  /** Signs the `kaki_oauth` cookie (`SESSION_SECRET`). */
  cookieSecret: string;
}

/** The PKCE verifier, state and nonce between start and callback (FEAT-005 §3.3). */
interface Pending {
  v: string;
  s: string;
  n: string;
  exp: number;
}

export const OAUTH_COOKIE = 'kaki_oauth';
export const OAUTH_COOKIE_TTL_S = 600;

export interface GoogleSignIn {
  /** The authorization URL and the signed cookie that must come back with the callback. */
  start(): Promise<{ url: string; cookie: string }>;
  /** Checks state, PKCE, nonce, the ID token and `email_verified`; returns who it is. */
  finish(callbackUrl: URL, cookie: string | undefined): Promise<{ sub: string; email: string }>;
}

/**
 * Google sign-in (AUTH-01) on `openid-client`: authorisation code with PKCE (S256),
 * state and nonce (ADR-020, FEAT-005 D1). Discovery runs on first use and is retried
 * after a failure. Any failed check throws `GoogleSignInError`.
 */
export function createGoogleSignIn(cfg: GoogleConfig): GoogleSignIn {
  let discovered: Promise<oidc.Configuration> | null = null;
  const configuration = () => {
    discovered ??= oidc
      .discovery(
        new URL(cfg.issuer),
        cfg.clientId,
        cfg.clientSecret,
        undefined,
        // Only a local test provider is plain HTTP; Google is always HTTPS.
        cfg.issuer.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        discovered = null;
        throw err;
      });
    return discovered;
  };

  return {
    async start() {
      const config = await configuration();
      const pending: Pending = {
        v: oidc.randomPKCECodeVerifier(),
        s: oidc.randomState(),
        n: oidc.randomNonce(),
        exp: Math.floor(Date.now() / 1000) + OAUTH_COOKIE_TTL_S,
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: cfg.redirectUri,
        scope: 'openid email',
        code_challenge: await oidc.calculatePKCECodeChallenge(pending.v),
        code_challenge_method: 'S256',
        state: pending.s,
        nonce: pending.n,
      });
      return { url: url.href, cookie: signToken({ ...pending }, cfg.cookieSecret) };
    },

    async finish(callbackUrl, cookie) {
      let pending: Pending;
      try {
        pending = verifyToken<Pending>(cookie ?? '', cfg.cookieSecret);
      } catch {
        throw new GoogleSignInError('missing or invalid oauth cookie');
      }
      const config = await configuration();
      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: pending.v,
          expectedState: pending.s,
          expectedNonce: pending.n,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch (err) {
        throw new GoogleSignInError(`code exchange failed: ${(err as Error).name}`);
      }
      if (!claims || typeof claims.sub !== 'string')
        throw new GoogleSignInError('no ID token subject');
      if (claims.email_verified !== true || typeof claims.email !== 'string')
        throw new GoogleSignInError('email not verified');
      return { sub: claims.sub, email: normaliseEmail(claims.email) };
    },
  };
}

/**
 * Signs in the user with Google's verified email (§5.4). The first Google sign-in binds
 * `google_sub`; a later one with a different `sub` for the same email is refused, and so
 * is a `sub` already bound to another user.
 */
export async function signInWithGoogle(
  idDb: ZoneDb,
  who: { sub: string; email: string },
): Promise<SignedIn> {
  return idDb.db.transaction(async (tx) => {
    const user = await findOrCreateUser(tx, who.email);
    if (user.status !== 'active') throw new GoogleSignInError('user disabled');
    if (user.googleSub !== null && user.googleSub !== who.sub)
      throw new GoogleSignInError('google account mismatch');
    if (user.googleSub === null) {
      const taken = await tx.execute(sql`select 1 from users where google_sub = ${who.sub}`);
      if (taken.rows.length > 0) throw new GoogleSignInError('google account bound elsewhere');
      await tx.execute(sql`update users set google_sub = ${who.sub} where id = ${user.id}`);
    }
    return startSession(tx, user.id, 'google');
  });
}
