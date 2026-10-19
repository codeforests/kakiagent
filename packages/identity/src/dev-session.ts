import { signToken, verifyToken } from '@kaki/platform';
import type { Role } from './capabilities.js';

/**
 * DEV-ONLY dashboard session for the walking skeleton (plan §2). A signed cookie for
 * the seeded owner; no table, no expiry handling beyond the token's own. The api
 * registers the route only when KAKI_DEV_AUTH=true outside production builds, and
 * the production bundle compiles it out. FEAT-005 replaces it with real sessions.
 */
export const DEV_SESSION_COOKIE = 'kaki_dev_session';

export interface DevSession {
  tenantId: string;
  userId: string;
  role: Role;
  exp: number;
}

export function issueDevSession(tenantId: string, secret: string, ttlSeconds = 12 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return signToken({ tenantId, userId: 'dev-owner', role: 'owner', exp }, secret);
}

export function readDevSession(cookie: string | undefined, secret: string): DevSession | null {
  if (!cookie) return null;
  try {
    return verifyToken<DevSession>(cookie, secret);
  } catch {
    return null;
  }
}
