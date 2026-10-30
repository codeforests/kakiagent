import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localSealer, SealError } from './secrets.js';

describe('localSealer', () => {
  const sealer = localSealer(randomBytes(32));

  it('opens what it sealed under the same AAD only', async () => {
    const plain = new TextEncoder().encode('secret');
    const { ciphertext, keyRef } = await sealer.seal(plain, 'mfa:1');
    expect(Buffer.from(ciphertext).includes(Buffer.from('secret'))).toBe(false);
    expect(await sealer.open(ciphertext, keyRef, 'mfa:1')).toEqual(plain);
    await expect(sealer.open(ciphertext, keyRef, 'mfa:2')).rejects.toBeInstanceOf(SealError);
    await expect(sealer.open(ciphertext, 'kms:x', 'mfa:1')).rejects.toBeInstanceOf(SealError);
  });

  it('needs a 32-byte key', () => {
    expect(() => localSealer(randomBytes(16))).toThrow(SealError);
  });
});
