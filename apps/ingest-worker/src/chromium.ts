import {
  assertPublicHost,
  BOT_USER_AGENT,
  type FetchedPage,
  type PageFetcher,
  type PageFetcherFactory,
  type Resolver,
} from '@kaki/kb';
import type { LiveTheme } from '@kaki/channels/theme';
import { chromium, errors, type Browser, type Route } from 'playwright-core';
import { z } from 'zod';

export interface ChromiumOptions {
  executablePath?: string | undefined;
  /** Lifts the request guard for local development and tests (dev-only, §5.6). */
  allowPrivate?: boolean;
  resolve?: Resolver;
  /**
   * Dev and test only: hosts served from somewhere else, `host → http://127.0.0.1:port`, so
   * the fixture site can stand in for a real domain (FEAT-012 §5.8). Ignored in production.
   */
  hostMap?: ReadonlyMap<string, string>;
  /** The page load cap (design §5.2: 15 s), network idle included. */
  pageTimeoutMs?: number;
}

/** What one page's text, title and links read as in the browser. */
const READ_PAGE = `(() => ({
  title: document.title || '',
  text: document.body ? document.body.innerText : '',
  links: Array.from(document.querySelectorAll('a[href]'), (a) => a.href).slice(0, 5000),
}))()`;
const SKIPPED_TYPES = new Set(['image', 'media', 'font']);
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_REDIRECTS = 10;

export interface ChromiumFetchers {
  /** Opens a browser context for one source's crawl (the job runner's fetcher factory). */
  open: PageFetcherFactory;
  /** Opens a site's page and runs the widget's theme detection there (FEAT-032 §5.4). */
  probeTheme(url: string, script: string): Promise<ThemeProbeResult>;
  healthy(): boolean;
  close(): Promise<void>;
}

export type ThemeProbeResult =
  | { ok: true; theme: LiveTheme }
  | { ok: false; failure: 'unreachable' | 'blocked' | 'timeout' | 'no_page' };

const LiveThemeShape = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
  font: z.string().max(200).nullable(),
  radius: z.number().min(0).max(20).nullable(),
  scheme: z.enum(['light', 'dark']),
});

/**
 * The worker's `PageFetcher` (FEAT-012 §5.2, D3, D7): one Chromium per worker, a fresh
 * context per source with the bot's user agent and JavaScript on, images, media and fonts
 * not loaded, and a request guard: every request's host must resolve to public addresses
 * or the request is aborted. The main document is fetched with redirects handed back to
 * the browser one hop at a time, so each hop is guarded and an off-domain hop is seen and
 * not requested.
 */
export function chromiumFetchers(opts: ChromiumOptions = {}): ChromiumFetchers {
  const pageTimeout = opts.pageTimeoutMs ?? 15_000;
  const hostMap = process.env.KAKI_BUILD !== 'production' ? (opts.hostMap ?? new Map()) : new Map();
  let browser: Promise<Browser> | null = null;
  let connected = false;

  const launch = () => {
    browser ??= chromium
      .launch({
        headless: true,
        ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        args: ['--disable-dev-shm-usage'],
      })
      .then((b) => {
        connected = true;
        b.on('disconnected', () => {
          connected = false;
          browser = null;
        });
        return b;
      })
      .catch((err: unknown) => {
        browser = null;
        throw err;
      });
    return browser;
  };

  /** The URL actually requested: the host map's target in dev, else the URL itself. */
  const target = (url: string) => {
    const u = new URL(url);
    const to = hostMap.get(u.hostname);
    return to ? `${to}${u.pathname}${u.search}` : url;
  };

  const open: PageFetcherFactory = async ({ hosts }) => {
    const context = await (
      await launch()
    ).newContext({
      userAgent: BOT_USER_AGENT,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const guarded = new Map<string, Promise<boolean>>();
    const isAllowed = (host: string) => {
      let p = guarded.get(host);
      if (!p) {
        p = assertPublicHost(host, {
          ...(opts.resolve ? { resolve: opts.resolve } : {}),
          allowPrivate: opts.allowPrivate ?? false,
        }).then(
          () => true,
          () => false,
        );
        guarded.set(host, p);
      }
      return p;
    };

    async function robots(origin: string) {
      let url = `${origin}/robots.txt`;
      // RFC 9309 §2.3.1.2: follow at least five redirects; each hop is guarded.
      for (let hop = 0; hop <= 5; hop++) {
        if (!(await isAllowed(new URL(url).hostname))) return null;
        let res: Response;
        try {
          res = await fetch(target(url), {
            redirect: 'manual',
            headers: { 'user-agent': BOT_USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          return null;
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          url = new URL(location, url).toString();
          continue;
        }
        const body = res.ok ? (await res.text()).slice(0, MAX_ROBOTS_BYTES) : '';
        if (!res.ok) await res.body?.cancel();
        return { status: res.status, body };
      }
      return null;
    }

    async function page(url: string): Promise<FetchedPage> {
      const tab = await context.newPage();
      const state: {
        status: number;
        contentType: string;
        redirect: string | null;
        blocked: boolean;
      } = { status: 0, contentType: '', redirect: null, blocked: false };

      await tab.route('**/*', async (route: Route) => {
        const req = route.request();
        const reqUrl = req.url();
        const { protocol, hostname } = new URL(reqUrl);
        const isMain = req.isNavigationRequest() && req.frame() === tab.mainFrame();
        if (protocol !== 'http:' && protocol !== 'https:') return route.abort('blockedbyclient');
        if (SKIPPED_TYPES.has(req.resourceType())) return route.abort('blockedbyclient');
        if (req.isNavigationRequest() && !isMain) return route.abort('blockedbyclient');
        // A script navigating the page off the site is not followed (KB-13).
        if (isMain && !hosts.includes(hostname)) return route.abort('blockedbyclient');
        if (!(await isAllowed(hostname))) {
          if (isMain) state.blocked = true;
          return route.abort('blockedbyclient');
        }
        const mapped = target(reqUrl);
        if (!isMain) return mapped === reqUrl ? route.continue() : fulfilFrom(route, mapped);
        let res;
        try {
          res = await route.fetch({ url: mapped, maxRedirects: 0, timeout: pageTimeout });
        } catch {
          return route.abort('failed');
        }
        state.status = res.status();
        state.contentType = res.headers()['content-type'] ?? '';
        const location = res.headers()['location'];
        if (res.status() >= 300 && res.status() < 400 && location) {
          // Followed by `page` itself, one navigation per hop (Playwright doesn't route
          // redirected requests), so every hop is scope-checked and guarded.
          state.redirect = new URL(location, reqUrl).toString();
          return route.abort('aborted');
        }
        if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(state.contentType))
          return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
        return route.fulfill({ response: res });
      });

      const started = Date.now();
      let current = url;
      try {
        for (let hop = 0; ; hop++) {
          state.redirect = null;
          try {
            await tab.goto(current, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
            break;
          } catch (err) {
            if (state.redirect && hop < MAX_REDIRECTS) {
              current = state.redirect;
              // An off-domain redirect (KB-13): noted, never requested.
              if (!hosts.includes(new URL(current).hostname))
                return offDomain(current, state.status);
              continue;
            }
            if (state.blocked) return { ok: false, reason: 'blocked_address' };
            if (err instanceof errors.TimeoutError) return { ok: false, reason: 'timeout' };
            return { ok: false, reason: 'load_error' };
          }
        }
        // JavaScript pages (KB-01): let the page settle, within the same cap.
        const left = pageTimeout - (Date.now() - started);
        if (left > 0)
          await tab.waitForLoadState('networkidle', { timeout: left }).catch(() => undefined);
        const read = (await tab.evaluate(READ_PAGE)) as {
          title: string;
          text: string;
          links: string[];
        };
        return {
          ok: true,
          finalUrl: current,
          httpStatus: state.status,
          contentType: state.contentType,
          title: read.title,
          text: read.text,
          links: read.links,
        };
      } catch {
        return { ok: false, reason: 'load_error' };
      } finally {
        await tab.close().catch(() => undefined);
      }
    }

    const fetcher: PageFetcher = {
      robots,
      page,
      close: () => context.close().catch(() => undefined),
    };
    return fetcher;
  };

  /**
   * The theme probe (FEAT-032 §5.4): a fresh guarded context in light mode, fonts loaded so
   * computed families are real, images and media skipped, every request host and every
   * redirect hop of the page guarded, 15 s in all. The detection script is evaluated in
   * the page (not a script tag, so the page's CSP can't block it) and its result checked.
   */
  async function probeTheme(url: string, script: string): Promise<ThemeProbeResult> {
    const context = await (
      await launch()
    ).newContext({
      userAgent: BOT_USER_AGENT,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      colorScheme: 'light',
    });
    const guarded = new Map<string, Promise<boolean>>();
    const isAllowed = (host: string) => {
      let p = guarded.get(host);
      if (!p) {
        p = assertPublicHost(host, {
          ...(opts.resolve ? { resolve: opts.resolve } : {}),
          allowPrivate: opts.allowPrivate ?? false,
        }).then(
          () => true,
          () => false,
        );
        guarded.set(host, p);
      }
      return p;
    };
    const started = Date.now();
    try {
      const tab = await context.newPage();
      const state = { status: 0, html: true, redirect: null as string | null, blocked: false };
      await tab.route('**/*', async (route: Route) => {
        const req = route.request();
        const reqUrl = req.url();
        const { protocol, hostname } = new URL(reqUrl);
        const isMain = req.isNavigationRequest() && req.frame() === tab.mainFrame();
        if (protocol !== 'http:' && protocol !== 'https:') return route.abort('blockedbyclient');
        if (req.resourceType() === 'image' || req.resourceType() === 'media')
          return route.abort('blockedbyclient');
        if (req.isNavigationRequest() && !isMain) return route.abort('blockedbyclient');
        if (!(await isAllowed(hostname))) {
          if (isMain) state.blocked = true;
          return route.abort('blockedbyclient');
        }
        const mapped = target(reqUrl);
        if (!isMain) return mapped === reqUrl ? route.continue() : fulfilFrom(route, mapped);
        let res;
        try {
          res = await route.fetch({ url: mapped, maxRedirects: 0, timeout: pageTimeout });
        } catch {
          return route.abort('failed');
        }
        state.status = res.status();
        const location = res.headers()['location'];
        if (res.status() >= 300 && res.status() < 400 && location) {
          state.redirect = new URL(location, reqUrl).toString();
          return route.abort('aborted');
        }
        state.html = /^(text\/html|application\/xhtml\+xml)\b/i.test(
          res.headers()['content-type'] ?? '',
        );
        return route.fulfill({ response: res });
      });
      let current = url;
      for (let hop = 0; ; hop++) {
        state.redirect = null;
        const left = pageTimeout - (Date.now() - started);
        if (left <= 0) return { ok: false, failure: 'timeout' };
        try {
          await tab.goto(current, { waitUntil: 'load', timeout: left });
          break;
        } catch (err) {
          if (state.redirect && hop < MAX_REDIRECTS) {
            current = state.redirect;
            continue;
          }
          if (state.blocked) return { ok: false, failure: 'blocked' };
          if (err instanceof errors.TimeoutError) return { ok: false, failure: 'timeout' };
          return { ok: false, failure: 'unreachable' };
        }
      }
      if (state.status >= 400 || !state.html) return { ok: false, failure: 'no_page' };
      const left = pageTimeout - (Date.now() - started);
      if (left > 0)
        await tab
          .waitForLoadState('networkidle', { timeout: Math.min(left, 3_000) })
          .catch(() => undefined);
      await tab.evaluate(script);
      const raw = await tab.evaluate(
        '(() => { const d = window.__kakiDetect; return typeof d === "function" ? d(document, window) : null; })()',
      );
      const theme = LiveThemeShape.safeParse(raw);
      return theme.success ? { ok: true, theme: theme.data } : { ok: false, failure: 'no_page' };
    } catch (err) {
      if (err instanceof errors.TimeoutError) return { ok: false, failure: 'timeout' };
      return { ok: false, failure: 'unreachable' };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  return {
    open,
    probeTheme,
    healthy: () => browser === null || connected,
    async close() {
      const b = await browser?.catch(() => null);
      browser = null;
      await b?.close();
    },
  };
}

function offDomain(url: string, httpStatus: number): FetchedPage {
  return {
    ok: true,
    finalUrl: url,
    httpStatus: httpStatus || 302,
    contentType: '',
    title: '',
    text: '',
    links: [],
  };
}

/** A sub-resource on a mapped host (dev and tests): fetched from the map's target. */
async function fulfilFrom(route: Route, url: string) {
  try {
    return await route.fulfill({ response: await route.fetch({ url }) });
  } catch {
    return route.abort('failed');
  }
}

/** Parses `host=http://127.0.0.1:5176,other=…` (CRAWL_HOST_MAP). */
export function parseHostMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [host, to] = pair.split('=').map((s) => s.trim());
    if (host && to) map.set(host.toLowerCase(), new URL(to).origin);
  }
  return map;
}
