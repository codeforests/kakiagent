/**
 * The sealed Telegram credential (FEAT-037 §5.2, D3): `{ token, webhookSecret }` as JSON,
 * sealed with the connection ID as AAD so a ciphertext copied to another row doesn't open.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SecretSealer } from '@kaki/platform/secrets';
import type { CredentialRef } from '../adapter.js';

export interface TelegramCredential {
  token: string;
  webhookSecret: string;
}

export const credentialAad = (connectionId: string) => `channel_connections:${connectionId}`;

export async function sealTelegram(
  sealer: SecretSealer,
  connectionId: string,
  cred: TelegramCredential,
): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
  return sealer.seal(new TextEncoder().encode(JSON.stringify(cred)), credentialAad(connectionId));
}

export class NoCredentialError extends Error {}

export async function openTelegram(
  sealer: SecretSealer,
  ref: CredentialRef,
): Promise<TelegramCredential> {
  if (!ref.ciphertext || !ref.keyRef) throw new NoCredentialError('telegram: no credential');
  const plain = await sealer.open(ref.ciphertext, ref.keyRef, credentialAad(ref.connectionId));
  const c = JSON.parse(new TextDecoder().decode(plain)) as Partial<TelegramCredential>;
  if (typeof c.token !== 'string' || typeof c.webhookSecret !== 'string')
    throw new NoCredentialError('telegram: malformed credential');
  return { token: c.token, webhookSecret: c.webhookSecret };
}

export const secretHash = (secret: string): Buffer =>
  createHash('sha256').update(secret, 'utf8').digest();

/** Constant-time check of the `X-Telegram-Bot-Api-Secret-Token` header against the stored hash. */
export function secretMatches(header: string | undefined, hash: Uint8Array | null): boolean {
  if (!header || !hash || hash.length !== 32) return false;
  return timingSafeEqual(secretHash(header), Buffer.from(hash));
}

/** The bot's numeric ID: the part of a BotFather token before the colon. */
export const botIdOf = (token: string): number => Number(token.split(':', 1)[0]);
