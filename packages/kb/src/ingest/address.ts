import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * The crawler's address guard (FEAT-012 D7): the crawler fetches tenant-supplied URLs from
 * inside our network, so a URL must never reach loopback, private, link-local (the cloud
 * metadata endpoint), CGNAT, multicast or reserved addresses.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped or -compatible IPv6 address, if any. */
function embeddedV4(ip: string): string | null {
  const m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True only for a public unicast address. Anything that isn't an IP address is false. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return !blocked.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4) return isPublicAddress(v4);
    return !blocked.check(bare, 'ipv6');
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class NonPublicHostError extends Error {}

/**
 * Resolves `host` and throws `NonPublicHostError` unless every address is public (one
 * private answer is enough to refuse: the connect could pick it). `allowPrivate` lifts the
 * guard for local development and tests only (FEAT-012 §5.6).
 */
export async function assertPublicHost(
  host: string,
  opts: { resolve?: Resolver; allowPrivate?: boolean } = {},
): Promise<void> {
  if (opts.allowPrivate && process.env.KAKI_BUILD !== 'production') return;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (!isPublicAddress(bare)) throw new NonPublicHostError('address not public');
    return;
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? dnsResolver)(bare);
  } catch (err) {
    throw new NonPublicHostError('host does not resolve', { cause: err });
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress))
    throw new NonPublicHostError('address not public');
}
