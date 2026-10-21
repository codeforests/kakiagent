import { describe, expect, it } from 'vitest';
import { assertPublicHost, isPublicAddress, NonPublicHostError } from './address.js';

describe('isPublicAddress (FEAT-012 D7)', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '[::1]',
    'localhost',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '203.117.1.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('assertPublicHost', () => {
  const resolve = (map: Record<string, string[]>) => async (h: string) => {
    if (!(h in map)) throw new Error('ENOTFOUND');
    return map[h]!;
  };

  it('accepts a host whose every address is public', async () => {
    await expect(
      assertPublicHost('bakery.sg', {
        resolve: resolve({ 'bakery.sg': ['8.8.8.8', '2606:4700::1'] }),
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a host with any private address, an unresolvable host and private literals', async () => {
    const r = resolve({ 'mixed.sg': ['8.8.8.8', '10.0.0.1'], 'meta.sg': ['169.254.169.254'] });
    for (const host of ['mixed.sg', 'meta.sg', 'nowhere.sg', '127.0.0.1', '[::1]'])
      await expect(assertPublicHost(host, { resolve: r }), host).rejects.toBeInstanceOf(
        NonPublicHostError,
      );
  });

  it('lets private hosts through only with allowPrivate outside production builds', async () => {
    await expect(assertPublicHost('127.0.0.1', { allowPrivate: true })).resolves.toBeUndefined();
    const prev = process.env.KAKI_BUILD;
    process.env.KAKI_BUILD = 'production';
    try {
      await expect(assertPublicHost('127.0.0.1', { allowPrivate: true })).rejects.toBeInstanceOf(
        NonPublicHostError,
      );
    } finally {
      if (prev === undefined) delete process.env.KAKI_BUILD;
      else process.env.KAKI_BUILD = prev;
    }
  });
});
