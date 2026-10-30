import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Sealed secrets: channel credentials (NFR-05; FEAT-034 D5) and TOTP secrets (FEAT-006 D3).
 * The AAD binds a blob to its row, so a ciphertext copied to another row doesn't open. The
 * KMS envelope sealer arrives with the first adapter that stores a credential (FEAT-037).
 */
export interface SecretSealer {
  seal(plain: Uint8Array, aad: string): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  open(ciphertext: Uint8Array, keyRef: string, aad: string): Promise<Uint8Array>;
}

export class SealError extends Error {
  override name = 'SealError';
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const LOCAL_KEY_REF = 'local:v1';

/** AES-256-GCM with a random IV; the blob is `iv ‖ tag ‖ ciphertext`. */
export function localSealer(key: Uint8Array): SecretSealer {
  if (key.length !== 32) throw new SealError('localSealer: the key must be 32 bytes');
  return {
    async seal(plain, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return {
        ciphertext: new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])),
        keyRef: LOCAL_KEY_REF,
      };
    },
    async open(ciphertext, keyRef, aad) {
      if (keyRef !== LOCAL_KEY_REF) throw new SealError('open: unknown key reference');
      if (ciphertext.length < IV_BYTES + TAG_BYTES) throw new SealError('open: blob too short');
      const buf = Buffer.from(ciphertext);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const body = buf.subarray(IV_BYTES + TAG_BYTES);
        return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
      } catch {
        // Never echo the blob or what decrypted so far.
        throw new SealError('open: the credential did not authenticate');
      }
    },
  };
}
