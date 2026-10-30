import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on node:crypto (FEAT-006 D1): HMAC-SHA1, 6 digits, 30-second steps, the
 * settings every authenticator app agrees on.
 */
export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new 160-bit secret (RFC 4226's recommended length). */
export const newTotpSecret = (): Buffer => randomBytes(20);

/** RFC 4648 base32, upper case, no padding. */
export function base32Encode(buf: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces and padding, as people type keys. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('base32Decode: invalid character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const totpStep = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);

/** The code for one step (RFC 4226 dynamic truncation). `digits` is for the RFC vectors. */
export function totpAt(secret: Uint8Array, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code against steps −1..+1 around `now` (clock drift), refusing any step at or
 * before `lastUsedStep` (replay). Returns the matched step so the caller can store it.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): { ok: true; step: number } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const given = Buffer.from(code);
  const current = totpStep(now);
  let matched: number | null = null;
  // Compare every candidate, so timing doesn't say which step matched.
  for (const step of [current - 1, current, current + 1]) {
    const same = timingSafeEqual(Buffer.from(totpAt(secret, step)), given);
    if (same && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

/** The Key URI Format authenticator apps read from the QR code. */
export function otpauthUri(secret: Uint8Array, email: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const params = [
    `secret=${base32Encode(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    `digits=${DIGITS}`,
    `period=${TOTP_PERIOD_S}`,
  ].join('&');
  return `otpauth://totp/${label}?${params}`;
}
