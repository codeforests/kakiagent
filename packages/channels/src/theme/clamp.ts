import { widgetTokens } from '@kaki/design-tokens/widget';
import { contrast, fromOklch, parseColour, toHex, toOklch, type Rgb } from './colour.js';

export type Scheme = 'light' | 'dark';

/** Reads one `--kaki-*` value from the generated declarations. */
export function tokenValue(decls: string, name: string): string {
  const m = new RegExp(`--kaki-${name}:([^;]*)`).exec(decls);
  return m ? m[1]!.trim() : '';
}

const SURFACE: Record<Scheme, Rgb> = {
  light: parseColour(tokenValue(widgetTokens.light, 'surface'))!,
  dark: parseColour(tokenValue(widgetTokens.dark, 'surface'))!,
};
/** The two on-accent candidates (tokens.json `widget.on-accent`, light and dark). */
const ON = [
  tokenValue(widgetTokens.light, 'on-accent'),
  tokenValue(widgetTokens.dark, 'on-accent'),
];

function onAccentFor(c: Rgb): { hex: string; ratio: number } {
  const [a, b] = ON.map((h) => ({ hex: h.toLowerCase(), ratio: contrast(c, parseColour(h)!) }));
  return a!.ratio >= b!.ratio ? a! : b!;
}

const passes = (c: Rgb, scheme: Scheme) =>
  onAccentFor(c).ratio >= 4.5 && contrast(c, SURFACE[scheme]) >= 3;

/**
 * Clamps an accent to WCAG AA (design.md §4.9): moves OKLCH lightness, the smallest step
 * either way, until on-accent text is ≥ 4.5:1 and the accent against the panel ≥ 3:1.
 */
export function clampAccent(
  hex: string,
  scheme: Scheme,
): { accent: string; onAccent: string; adjusted: boolean } {
  const rgb = parseColour(hex) ?? parseColour(tokenValue(widgetTokens[scheme], 'accent'))!;
  let best = rgb;
  let adjusted = false;
  if (!passes(rgb, scheme)) {
    const [L, C, h] = toOklch(rgb);
    adjusted = true;
    best = fromOklch([scheme === 'light' ? 0 : 1, 0, 0]);
    for (let step = 0.01; step <= 1; step += 0.01) {
      const hit = [L - step, L + step]
        .filter((l) => l >= 0 && l <= 1)
        .map((l) => fromOklch([l, C, h]))
        .find((c) => passes(c, scheme));
      if (hit) {
        best = hit;
        break;
      }
    }
  }
  return { accent: toHex(best), onAccent: onAccentFor(best).hex, adjusted };
}
