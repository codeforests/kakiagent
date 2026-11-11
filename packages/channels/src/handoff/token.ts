import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Handoff link codes (CHN-07; FEAT-038 §5.1, D4). `prefix + base64url(linkId ‖ mac)`, where
 * `mac` is the first 16 bytes of HMAC-SHA256(secret, tenantId ‖ prefix ‖ linkId). Signed, not
 * stored: the email worker re-signs from the link ID, so no code sits in an outbox row. Single
 * use and expiry come from the `handoff_links` row.
 */
export type HandoffLinkChannel = 'telegram' | 'email';

/** Telegram's `start` payload: `[A-Za-z0-9_-]{1,64}`. `c-` never matches the alert `link-…` codes. */
const PREFIX: Record<HandoffLinkChannel, string> = { telegram: 'c-', email: 'e-' };
const BODY_LENGTH = 43; // base64url of 32 bytes, unpadded
export const HANDOFF_CODE = /^[ce]-[A-Za-z0-9_-]{43}$/;

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const uuidOf = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const mac = (secret: string, tenantId: string, prefix: string, linkId: Buffer) =>
  createHmac('sha256', secret)
    .update(uuidBytes(tenantId))
    .update(prefix)
    .update(linkId)
    .digest()
    .subarray(0, 16);

export function signHandoff(
  secret: string,
  tenantId: string,
  linkId: string,
  channel: HandoffLinkChannel,
): string {
  const prefix = PREFIX[channel];
  const id = uuidBytes(linkId);
  return prefix + Buffer.concat([id, mac(secret, tenantId, prefix, id)]).toString('base64url');
}

/** The link ID a well-formed code names, unverified (the confirm page's tenant lookup, §5.4). */
export function peekHandoff(code: string): { linkId: string; channel: HandoffLinkChannel } | null {
  if (!HANDOFF_CODE.test(code)) return null;
  const raw = Buffer.from(code.slice(2), 'base64url');
  if (raw.length !== 32) return null;
  return { linkId: uuidOf(raw.subarray(0, 16)), channel: code[0] === 'c' ? 'telegram' : 'email' };
}

/** The link a code names when its MAC is right for this tenant; otherwise null. */
export function openHandoff(
  secret: string,
  tenantId: string,
  code: string,
): { linkId: string; channel: HandoffLinkChannel } | null {
  const peeked = peekHandoff(code);
  if (!peeked || code.length !== 2 + BODY_LENGTH) return null;
  const raw = Buffer.from(code.slice(2), 'base64url');
  const expected = mac(secret, tenantId, code.slice(0, 2), raw.subarray(0, 16));
  return timingSafeEqual(expected, raw.subarray(16)) ? peeked : null;
}
