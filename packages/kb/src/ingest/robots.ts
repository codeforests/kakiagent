/**
 * robots.txt (RFC 9309) for the crawler (KB-01; FEAT-012 §5.2). The crawler's product
 * token is `KakiAgentBot`; without a group for it, the `*` group applies.
 */
export const BOT_TOKEN = 'kakiagentbot';
export const BOT_USER_AGENT = 'KakiAgentBot/1.0 (+https://kakiagent.sg/bot)';
/** Crawl-delay is honoured up to this many seconds per host. */
export const MAX_CRAWL_DELAY_S = 5;

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  allowed(url: string): boolean;
  /** Seconds between requests to this host, capped at MAX_CRAWL_DELAY_S. */
  crawlDelay: number;
}

const ALLOW_ALL: RobotsPolicy = { allowed: () => true, crawlDelay: 0 };
const DISALLOW_ALL: RobotsPolicy = {
  allowed: (url) => pathOf(url) === '/robots.txt',
  crawlDelay: 0,
};

/** Upper-cases percent escapes so `%2f` and `%2F` compare equal. */
const canonical = (s: string) => s.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return canonical(u.pathname + u.search);
  } catch {
    return '/';
  }
}

/** True if `pattern` (with `*` and a trailing `$`) matches the start of `path`. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path);
}

/** Parses a robots.txt body into the rules for this crawler. */
export function parseRobots(body: string): RobotsPolicy {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((key === 'allow' || key === 'disallow') && value !== '')
      current.rules.push({ allow: key === 'allow', pattern: canonical(value) });
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === BOT_TOKEN));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.reduce<number | null>((d, g) => g.delay ?? d, null);
  return {
    crawlDelay: Math.min(delay ?? 0, MAX_CRAWL_DELAY_S),
    allowed(url) {
      const path = pathOf(url);
      if (path === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!matches(r.pattern, path)) continue;
        // Longest match wins; on a tie, allow wins (RFC 9309 §2.2.2).
        if (
          !best ||
          r.pattern.length > best.pattern.length ||
          (r.pattern.length === best.pattern.length && r.allow)
        )
          best = r;
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * The policy for a fetched robots.txt: 2xx is parsed; 4xx means no restrictions; 5xx or
 * unreachable means disallow everything (RFC 9309 §2.3.1).
 */
export function robotsPolicy(res: { status: number; body: string } | null): RobotsPolicy {
  if (!res || res.status >= 500) return DISALLOW_ALL;
  if (res.status >= 400) return ALLOW_ALL;
  if (res.status >= 200 && res.status < 300) return parseRobots(res.body.slice(0, 500_000));
  return ALLOW_ALL;
}
