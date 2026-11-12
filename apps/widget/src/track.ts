/**
 * First-party page tracking (FEAT-029 §5.2, in the loader): page views with visible
 * dwell and scroll, UTM and the external referrer host on a session's first view,
 * batched to `/widget/v1/events` with the token in the body (D8). Path only, never
 * query or fragment (D4). It never patches `history` and never throws into the host
 * page (NFR-14).
 */
import type { TrackEvent, TrackingMode, Utm } from '@kaki/contracts';

export type TrackingChoice = 'accepted' | 'declined';

const CHOICE_KEY = 'kaki.track';
const SESSION_KEY = 'kaki.sid';
/** The widget's stored choice is ignored after 12 months (D6). */
export const CHOICE_TTL_MS = 365 * 24 * 3600 * 1000;
const MAX_DWELL = 86_400_000;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The path only: segments with `@` or 6+ digits dropped (the server masks again). */
export function pathOf(loc: { pathname: string }): string {
  const segs = loc.pathname.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const kept = segs.filter((s, i) => i === 0 || !(s.includes('@') || /\d{6,}/.test(s)));
  const path = kept.join('/') || '/';
  return (path.startsWith('/') ? path : `/${path}`).slice(0, 512);
}

/** The five `utm_*` keys, values cut to 100; undefined when none. */
export function utmOf(search: string): Utm | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const utm: Utm = {};
  for (const k of UTM_KEYS) {
    const v = params.get(`utm_${k}`)?.trim();
    if (v) utm[k] = v.slice(0, 100);
  }
  return Object.keys(utm).length ? utm : undefined;
}

/** The referrer's host when it is another site; undefined for same-site or none. */
export function referrerHost(referrer: string, ownHost: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname;
    return host && host !== ownHost ? host.slice(0, 253) : undefined;
  } catch {
    return undefined;
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
function local(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The visitor's stored answer to the tracking prompt, or null (none, expired, blocked). */
export function storedChoice(
  store: Store | null = local(),
  now = Date.now(),
): TrackingChoice | null {
  try {
    const raw = store?.getItem(CHOICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { c?: unknown; at?: unknown };
    if ((v.c !== 'accepted' && v.c !== 'declined') || typeof v.at !== 'number') return null;
    return now - v.at > CHOICE_TTL_MS ? null : v.c;
  } catch {
    return null;
  }
}

export function storeChoice(c: TrackingChoice, store: Store | null = local(), now = Date.now()) {
  try {
    store?.setItem(CHOICE_KEY, JSON.stringify({ c, at: now }));
  } catch {
    /* storage blocked: the prompt asks again next visit */
  }
}

/** Whether the tracker runs (§5.2): `on`, or consent mode once accepted. */
export function tracks(mode: TrackingMode, choice: TrackingChoice | null): boolean {
  return mode === 'on' || (mode === 'consent' && choice === 'accepted');
}

function sessionOf(): { id: string; fresh: boolean } {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    if (s) return { id: s, fresh: false };
    const id = uuid();
    sessionStorage.setItem(SESSION_KEY, id);
    return { id, fresh: true };
  } catch {
    return { id: uuid(), fresh: true };
  }
}

function transport(url: string, token: string) {
  return (events: TrackEvent[]) => {
    try {
      const body = JSON.stringify({ token, events });
      if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return;
      void fetch(url, {
        method: 'POST',
        body,
        keepalive: true,
        credentials: 'omit',
        headers: { 'content-type': 'text/plain' },
      }).catch(() => {});
    } catch {
      /* dropped silently */
    }
  };
}

/** Starts the runner; `stop()` removes every listener and drops what is queued. */
export function startTracker(apiUrl: string, token: string): { stop(): void } {
  const send = transport(`${apiUrl}/widget/v1/events`, token);
  const session = sessionOf();
  let first = session.fresh;
  let queue: TrackEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let view: { id: string; path: string; ms: number; since: number | null; scroll: number } | null =
    null;
  let rafPending = false;
  const offs: Array<() => void> = [];
  const on = (t: EventTarget, ev: string, fn: () => void, opts?: AddEventListenerOptions) => {
    const h = () => {
      try {
        fn();
      } catch {
        /* never into the host page */
      }
    };
    t.addEventListener(ev, h, opts);
    offs.push(() => t.removeEventListener(ev, h, opts));
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length) send(queue.splice(0, 20));
  };
  const push = (e: TrackEvent) => {
    queue.push(e);
    if (!timer) timer = setTimeout(flush, 5000);
  };
  const visible = () => document.visibilityState !== 'hidden';
  const engage = () => {
    if (!view) return;
    const now = Date.now();
    if (view.since !== null) {
      view.ms += now - view.since;
      view.since = visible() ? now : null;
    }
    push({
      type: 'engage',
      id: view.id,
      dwellMs: Math.min(MAX_DWELL, Math.max(0, Math.round(view.ms))),
      scroll: view.scroll,
    });
  };
  const measureScroll = () => {
    if (!view) return;
    const el = document.documentElement;
    const total = Math.max(el.scrollHeight, 1);
    const pct = Math.round(((window.scrollY + window.innerHeight) / total) * 100);
    view.scroll = Math.max(view.scroll, Math.min(100, Math.max(0, pct)));
  };
  const startView = () => {
    if (view) engage();
    const path = pathOf(location);
    view = { id: uuid(), path, ms: 0, since: visible() ? Date.now() : null, scroll: 0 };
    measureScroll();
    const e: TrackEvent = {
      type: 'view',
      id: view.id,
      sessionId: session.id,
      path,
      at: new Date().toISOString(),
    };
    if (first) {
      const ref = referrerHost(document.referrer, location.hostname);
      const utm = utmOf(location.search);
      if (ref) e.referrer = ref;
      if (utm) e.utm = utm;
      first = false;
    }
    push(e);
  };
  const routeCheck = () => {
    if (view && pathOf(location) !== view.path) startView();
  };

  try {
    startView();
    on(document, 'visibilitychange', () => {
      if (!view) return;
      if (visible()) view.since = Date.now();
      else {
        engage();
        flush();
      }
    });
    on(window, 'pagehide', () => {
      engage();
      flush();
    });
    on(window, 'popstate', routeCheck);
    on(
      window,
      'scroll',
      () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          measureScroll();
        });
      },
      { passive: true },
    );
    const poll = setInterval(() => {
      try {
        routeCheck();
      } catch {
        /* ignore */
      }
    }, 1000);
    offs.push(() => clearInterval(poll));
  } catch {
    /* tracking is best effort */
  }

  return {
    stop() {
      for (const off of offs.splice(0)) off();
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
      view = null;
    },
  };
}
