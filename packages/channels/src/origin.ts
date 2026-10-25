/**
 * The allowed-origin rule (CHN-11; FEAT-032 §3, D3): a bare host or a URL becomes
 * `https://host[:port]`, lower-case, nothing else. No wildcards, IP literals, hosts
 * without a dot, or `http:` except `http://localhost[:port]` outside production builds.
 */
export class InvalidOriginError extends Error {
  constructor() {
    super('Enter a website address such as bakery.sg or https://www.bakery.sg');
  }
}

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normaliseOrigin(
  input: string,
  opts: { allowLocalhost?: boolean } = { allowLocalhost: process.env.KAKI_BUILD !== 'production' },
): string {
  const raw = input.trim();
  if (!raw || raw.includes('*') || raw.length > 300) throw new InvalidOriginError();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new InvalidOriginError();
  }
  if (u.username || u.password) throw new InvalidOriginError();
  const host = u.hostname.replace(/\.$/, '');
  if (u.protocol === 'http:' && opts.allowLocalhost && host === 'localhost') {
    return `http://localhost${u.port ? `:${u.port}` : ''}`;
  }
  if (u.protocol !== 'https:') throw new InvalidOriginError();
  // IPv4 literals look like dotted hosts; IPv6 literals keep their brackets.
  if (/^\d+(\.\d+)*$/.test(host) || host.startsWith('[') || !HOST_RE.test(host)) {
    throw new InvalidOriginError();
  }
  if (/\.\d+$/.test(host)) throw new InvalidOriginError();
  return `https://${host}${u.port ? `:${u.port}` : ''}`;
}
