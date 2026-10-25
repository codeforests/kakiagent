/**
 * Colour maths for the widget theme (CHN-14, design.md §4.9): parsing computed colours,
 * sRGB ↔ OKLCH and WCAG contrast. DOM-free and Node-free, so the loader can bundle it.
 */
export type Rgb = [number, number, number];

/** Parses `#rgb`, `#rrggbb`, `rgb()` or `rgba()`; null for transparent or anything else. */
export function parseColour(s: string | null | undefined): Rgb | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (m) {
    const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a < 0.5) return null;
  }
  return [+m[1]!, +m[2]!, +m[3]!].map((c) => Math.min(255, Math.round(c))) as Rgb;
}

export function toHex(c: Rgb): string {
  return (
    '#' +
    c
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const lin = (v: number) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const unlin = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export type Oklch = [l: number, c: number, h: number];

export function toOklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** Back to sRGB, clipped to the gamut. */
export function fromOklch([L, C, h]: Oklch): Rgb {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ].map((v) => Math.round(Math.max(0, Math.min(255, v)))) as Rgb;
}
