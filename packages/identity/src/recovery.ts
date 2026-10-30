import { createHash, randomInt } from 'node:crypto';

/**
 * Recovery codes (AUTH-03; FEAT-006 §5.2, D5): ten single-use codes of ten characters from
 * a 32-letter alphabet without the look-alikes 0, O, 1 and I (50 bits each), shown as
 * `xxxxx-xxxxx`. Only the SHA-256 of the normalised code is stored.
 */
export const RECOVERY_ALPHABET = 'abcdefghjklmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 10;

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += RECOVERY_ALPHABET[randomInt(32)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Ten distinct codes, formatted for display. */
export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newCode());
  return [...codes];
}

/** Lower case, without hyphens or spaces: how a typed code is compared. */
export const normaliseRecoveryCode = (code: string): string =>
  code.toLowerCase().replace(/[\s-]/g, '');

export const hashRecoveryCode = (code: string): Buffer =>
  createHash('sha256').update(normaliseRecoveryCode(code)).digest();
