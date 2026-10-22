import { isIP } from 'node:net';

/** A website source's confirmed scope (KB-13): the domain, its www host, listed subdomains. */
export interface WebsiteScope {
  /** The start URL, normalised. */
  url: string;
  /** The confirmed domain: the URL's host without a leading `www.`. */
  domain: string;
  subdomains: string[];
  /** Every host a page may be on. */
  hosts: string[];
}

export class InvalidWebsiteError extends Error {
  constructor(
    message: string,
    readonly field: 'url' | 'subdomains',
  ) {
    super(message);
  }
}

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const MAX_URL_LENGTH = 2000;
export const MAX_SUBDOMAINS = 20;

/**
 * Parses what the owner typed into a website scope. A bare `kakibakery.sg` gets
 * `https://`. Refuses credentials, non-default ports, IP literals and `localhost`
 * (FEAT-012 §3.2), and subdomains not under the domain. Throws `InvalidWebsiteError`.
 */
export function parseWebsite(input: string, subdomains: string[] = []): WebsiteScope {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidWebsiteError('not a web address', 'url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new InvalidWebsiteError('only http and https', 'url');
  if (u.username || u.password)
    throw new InvalidWebsiteError('no credentials in the address', 'url');
  if (u.port) throw new InvalidWebsiteError('no port in the address', 'url');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) || !HOST_RE.test(host))
    throw new InvalidWebsiteError('a domain name is needed', 'url');
  const domain = host.startsWith('www.') ? host.slice(4) : host;
  if (!HOST_RE.test(domain)) throw new InvalidWebsiteError('a domain name is needed', 'url');
  if (subdomains.length > MAX_SUBDOMAINS)
    throw new InvalidWebsiteError(`at most ${MAX_SUBDOMAINS} subdomains`, 'subdomains');
  const subs = [
    ...new Set(
      subdomains
        .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
        .filter((s) => s !== '' && s !== domain && s !== `www.${domain}`),
    ),
  ].sort();
  for (const s of subs)
    if (!HOST_RE.test(s) || !s.endsWith(`.${domain}`))
      throw new InvalidWebsiteError(`${s} is not under ${domain}`, 'subdomains');
  const url = normaliseUrl(u.toString());
  if (!url || url.length > MAX_URL_LENGTH) throw new InvalidWebsiteError('address too long', 'url');
  return { url, domain, subdomains: subs, hosts: [domain, `www.${domain}`, ...subs] };
}

/**
 * The form a URL is compared and stored in: lower-case host, no fragment, no default
 * index file, no trailing slash except the root, query kept. Null for anything that
 * isn't an http(s) URL on the default port.
 */
export function normaliseUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.port || u.username || u.password)
    return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  let path = u.pathname.replace(/\/index\.html?$/i, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  u.pathname = path || '/';
  const out = u.toString();
  return out.length > MAX_URL_LENGTH ? null : out;
}

/** True if a normalised URL is on one of the scope's hosts (any scheme, default port). */
export function inScope(url: string, hosts: readonly string[]): boolean {
  try {
    return hosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The widget origins a confirmed scope adds (KB-13 → CHN-11). */
export function originsOf(scope: Pick<WebsiteScope, 'hosts'>): string[] {
  return scope.hosts.map((h) => `https://${h}`);
}
