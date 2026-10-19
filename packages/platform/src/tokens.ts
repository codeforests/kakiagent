import { createHmac, timingSafeEqual } from 'node:crypto';

export class TokenError extends Error {}

/**
 * Compact HMAC-SHA256 signed tokens: `base64url(json).base64url(sig)`.
 * Used for the widget visitor token (ADR-016 decision 6) and, until FEAT-005, the
 * dev-only dashboard session. `exp` is seconds since the epoch.
 */
export function signToken(
  payload: Record<string, unknown> & { exp: number },
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T extends { exp: number }>(
  token: string,
  secret: string,
  now = Date.now(),
): T {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new TokenError('malformed token');
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new TokenError('bad signature');
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    throw new TokenError('malformed payload');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) throw new TokenError('expired');
  return payload;
}
