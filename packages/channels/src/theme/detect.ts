import { luminance, parseColour, toHex, toOklch } from './colour.js';
import type { Scheme } from './clamp.js';

/** What the page looks like (ADR-016 decision 3); null where nothing usable was found. */
export interface LiveTheme {
  accent: string | null;
  font: string | null;
  radius: number | null;
  scheme: Scheme;
}

const ICON_FONT = /icon|awesome|material|symbol|emoji/i;
const GENERIC =
  /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|inherit|initial)$/i;

/** The first family in a `font-family` list that isn't an icon, decorative or generic font. */
export function pickFont(list: string | null | undefined): string | null {
  for (const raw of (list ?? '').split(',')) {
    const f = raw.trim().replace(/^["']|["']$/g, '');
    if (f && !ICON_FONT.test(f) && !GENERIC.test(f) && /^[\w -]+$/.test(f)) return f;
  }
  return null;
}

/** The most frequent saturated colour (OKLCH chroma > 0.06), as hex; null if none. */
export function pickSaturated(colours: readonly (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const c of colours) {
    const rgb = parseColour(c);
    if (!rgb || toOklch(rgb)[1] <= 0.06) continue;
    const hex = toHex(rgb);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [hex, k] of counts) if (k > n) [best, n] = [hex, k];
  return best;
}

/** The median of the sampled radii, clamped 0–20; null with no samples. */
export function medianRadius(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  const m = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return Math.round(Math.max(0, Math.min(20, m)));
}

/** Dark when the background's luminance is under 0.4; else the page's `color-scheme`. */
export function schemeOf(background: string | null, colorScheme: string | null): Scheme {
  const rgb = parseColour(background);
  if (rgb) return luminance(rgb) < 0.4 ? 'dark' : 'light';
  return /^\s*dark\s*$/.test(colorScheme ?? '') ? 'dark' : 'light';
}

/**
 * The few DOM members detection reads, typed structurally so the module compiles without
 * the DOM library in Node packages; a real `document` and `window` fit them.
 */
interface El {
  readonly parentElement: El | null;
  getAttribute(name: string): string | null;
}
interface Doc {
  readonly body: El | null;
  readonly documentElement: El;
  querySelector(selectors: string): El | null;
  querySelectorAll(selectors: string): Iterable<El>;
}
interface Style {
  readonly backgroundColor: string;
  readonly borderTopLeftRadius: string;
  readonly color: string;
  readonly colorScheme: string;
  readonly fontFamily: string;
  readonly position: string;
}
interface Win {
  getComputedStyle(el: El): Style;
}

const SAMPLE = 'button, [class*=btn], a[class*=button], [role=button]';

/** Reads the page's look from computed styles (ADR-016 decision 3). Never throws. */
export function detectTheme(doc: Doc, win: Win): LiveTheme {
  const css = (el: El) => win.getComputedStyle(el);
  let background: string | null = null;
  for (let el: El | null = doc.body; el; el = el.parentElement) {
    const bg = css(el).backgroundColor;
    if (parseColour(bg)) {
      background = bg;
      break;
    }
  }
  const scheme = schemeOf(background, css(doc.documentElement).colorScheme);
  const buttons = [...doc.querySelectorAll(SAMPLE)]
    .filter(
      (el) =>
        (el as { offsetParent?: unknown }).offsetParent !== null || css(el).position === 'fixed',
    )
    .slice(0, 40)
    .map(css);
  const meta = doc.querySelector('meta[name=theme-color]')?.getAttribute('content');
  const accent =
    pickSaturated([meta]) ??
    pickSaturated(buttons.map((s) => s.backgroundColor)) ??
    pickSaturated([...doc.querySelectorAll('a[href]')].slice(0, 40).map((a) => css(a).color));
  return {
    accent,
    font: doc.body ? pickFont(css(doc.body).fontFamily) : null,
    radius: medianRadius(buttons.map((s) => parseFloat(s.borderTopLeftRadius))),
    scheme,
  };
}
