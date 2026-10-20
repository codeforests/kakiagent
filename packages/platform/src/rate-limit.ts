import { Redis } from 'iovalkey';

export interface RateLimitResult {
  allowed: boolean;
  /** Hits counted in the current window, this one included. */
  count: number;
}

/**
 * Fixed-window counters (FEAT-005 §5.3): the first hit opens a window of `windowMs`,
 * and up to `limit` hits are allowed in it. Keys must not hold personal data; hash
 * emails before using them.
 */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  close(): Promise<void>;
}

/** Valkey-backed, shared by every api task. INCR, then PEXPIRE NX opens the window once. */
export function createRateLimiter(url: string): RateLimiter {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
  return {
    async hit(key, limit, windowMs) {
      const res = await client.multi().incr(key).pexpire(key, windowMs, 'NX').exec();
      if (!res) throw new Error('rate limiter: transaction aborted');
      const [err, count] = res[0]!;
      if (err) throw err;
      return { allowed: (count as number) <= limit, count: count as number };
    },
    async close() {
      await client.quit();
    },
  };
}

/** In-process limiter with the same semantics, for tests and single-process tools. */
export function memoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, limit, windowMs) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count++;
      return { allowed: w.count <= limit, count: w.count };
    },
    async close() {
      windows.clear();
    },
  };
}
