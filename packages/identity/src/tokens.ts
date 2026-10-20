import { createHash, createHmac, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url: the length of every token this module issues. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const isTokenShaped = (token: unknown): token is string =>
  typeof token === 'string' && TOKEN_RE.test(token);

/** A session token (ADR-020): 256 random bits. Only its hash is stored. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/** What the database stores for a session or magic-link token. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/**
 * The magic-link token for a link ID: HMAC-SHA256 under `MAGIC_LINK_SECRET` (FEAT-005 D6).
 * A retry re-derives it from the ID, so no plaintext token is ever stored.
 */
export const magicLinkToken = (secret: string, linkId: string): string =>
  createHmac('sha256', secret).update(`magic-link:${linkId}`).digest('base64url');
