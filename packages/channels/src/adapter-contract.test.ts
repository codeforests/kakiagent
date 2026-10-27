import { describe, expect, it } from 'vitest';
import { fakeAdapter, fakeFixtures, fakeTransport } from '../test/fake-adapter.js';
import { adapterContractSuite } from './contract-suite.js';
import { CHANNEL_REGISTRY, connectable, registryEntry, type ChannelRegistry } from './registry.js';
import { localSealer, SealError } from './secrets.js';

const transport = fakeTransport();
adapterContractSuite(
  'fake',
  () => fakeAdapter(transport),
  () => fakeFixtures(transport),
);

describe('channel registry (ADR-011)', () => {
  const registry: ChannelRegistry = [
    ...CHANNEL_REGISTRY,
    {
      kind: 'telegram',
      name: 'Telegram',
      adapter: async () => fakeAdapter(transport),
      checksHealth: true,
      offlineModes: ['message'],
      connectPath: '/settings/channels/telegram',
    },
  ];

  it('registers the widget without an adapter or health check (D2)', () => {
    expect(registryEntry('widget')).toMatchObject({
      checksHealth: false,
      offlineModes: ['hidden', 'message'],
    });
    expect(registryEntry('widget')?.adapter).toBeUndefined();
    expect(registryEntry('telegram')).toBeUndefined();
    expect(registryEntry('telegram', registry)?.name).toBe('Telegram');
  });

  it('connectable leaves out connected kinds and kinds without a connect flow', () => {
    expect(connectable(registry, ['widget'])).toEqual([
      { kind: 'telegram', name: 'Telegram', connectPath: '/settings/channels/telegram' },
    ]);
    expect(connectable(registry, ['widget', 'telegram'])).toEqual([]);
    expect(connectable(CHANNEL_REGISTRY, [])).toEqual([]);
  });
});

describe('localSealer (NFR-05, D5)', () => {
  const key = new Uint8Array(32).fill(7);
  const sealer = localSealer(key);
  const plain = new TextEncoder().encode('bot-token-123456');
  const aad = '99999999-9999-4999-8999-999999999999';

  it('round-trips under the same AAD', async () => {
    const { ciphertext, keyRef } = await sealer.seal(plain, aad);
    expect(keyRef).toBe('local:v1');
    expect(Buffer.from(ciphertext).includes(Buffer.from(plain))).toBe(false);
    expect(await sealer.open(ciphertext, keyRef, aad)).toEqual(plain);
  });

  it('fails on a flipped byte, a different AAD or key ref, without leaking plaintext', async () => {
    const { ciphertext, keyRef } = await sealer.seal(plain, aad);
    const flipped = new Uint8Array(ciphertext);
    flipped[flipped.length - 1]! ^= 1;
    for (const attempt of [
      () => sealer.open(flipped, keyRef, aad),
      () => sealer.open(ciphertext, keyRef, 'another-connection'),
      () => sealer.open(ciphertext, 'kms:v1', aad),
      () => sealer.open(ciphertext.subarray(0, 10), keyRef, aad),
    ]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SealError);
      expect(String((err as Error).message)).not.toContain('bot-token');
    }
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => localSealer(new Uint8Array(16))).toThrow(SealError);
  });
});
