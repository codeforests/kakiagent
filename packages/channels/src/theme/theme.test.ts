import { widgetTokens } from '@kaki/design-tokens/widget';
import { describe, expect, it } from 'vitest';
import {
  clampAccent,
  contrast,
  fromOklch,
  medianRadius,
  parseColour,
  pickFont,
  pickSaturated,
  resolveTheme,
  schemeOf,
  toHex,
  toOklch,
  tokenValue,
  type Scheme,
} from './index.js';

const surface = (s: Scheme) => parseColour(tokenValue(widgetTokens[s], 'surface'))!;

describe('colour', () => {
  it('parses hex, rgb and rgba, and treats transparent as no colour', () => {
    expect(parseColour('#C2410C')).toEqual([194, 65, 12]);
    expect(parseColour('#fff')).toEqual([255, 255, 255]);
    expect(parseColour('rgb(14, 116, 144)')).toEqual([14, 116, 144]);
    expect(parseColour('rgb(14 116 144 / 0.9)')).toEqual([14, 116, 144]);
    expect(parseColour('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseColour('transparent')).toBeNull();
    expect(parseColour('red')).toBeNull();
  });

  it('round-trips sRGB through OKLCH', () => {
    for (const hex of ['#c2410c', '#0e7490', '#f6c453', '#000000', '#ffffff', '#7c3aed']) {
      expect(toHex(fromOklch(toOklch(parseColour(hex)!)))).toBe(hex);
    }
  });
});

describe('clampAccent (design.md §4.9)', () => {
  it('always gives AA on-accent text and a 3:1 accent against the panel', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (let r = 0; r <= 255; r += 51)
        for (let g = 0; g <= 255; g += 51)
          for (let b = 0; b <= 255; b += 51) {
            const { accent, onAccent } = clampAccent(toHex([r, g, b]), scheme);
            const c = parseColour(accent)!;
            expect(contrast(c, parseColour(onAccent)!)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(c, surface(scheme))).toBeGreaterThanOrEqual(3);
          }
    }
  });

  it("leaves the anchor's #C2410C on dark unchanged and adjusts #F6C453 on light", () => {
    expect(clampAccent('#C2410C', 'dark')).toEqual({
      accent: '#c2410c',
      onAccent: '#ffffff',
      adjusted: false,
    });
    const pale = clampAccent('#F6C453', 'light');
    expect(pale.adjusted).toBe(true);
    expect(pale.accent).not.toBe('#f6c453');
    // Same hue family: only lightness moved.
    const [, , h0] = toOklch(parseColour('#f6c453')!);
    expect(Math.abs(toOklch(parseColour(pale.accent)!)[2] - h0)).toBeLessThan(0.15);
  });
});

describe('resolveTheme', () => {
  const live = { accent: '#1d4ed8', font: 'Lora', radius: 6, scheme: 'light' as const };
  const stored = { accent: '#7c3aed', font: 'Merriweather', radius: 2, scheme: 'dark' as const };

  it('takes override > live > stored > default per token', () => {
    const all = resolveTheme({ overrides: { radius: 10 }, live, stored }, widgetTokens);
    expect(all.scheme).toBe('light');
    expect(all.vars).toContain('--kaki-accent:#1d4ed8');
    expect(all.vars).toContain('--kaki-radius:10px');
    expect(all.vars).toMatch(/--kaki-font:"Lora", system-ui/);
    const fromStored = resolveTheme({ overrides: {}, live: null, stored }, widgetTokens);
    expect(fromStored.scheme).toBe('dark');
    expect(fromStored.vars.startsWith(widgetTokens.dark)).toBe(true);
    expect(fromStored.vars).toContain('--kaki-radius:2px');
    const none = resolveTheme({ overrides: {} }, widgetTokens);
    expect(none.accent).toBe(tokenValue(widgetTokens.light, 'accent').toLowerCase());
    expect(none.vars).not.toMatch(/--kaki-radius:\d+px$/);
  });

  it('clamps an override accent too, and caps the radius', () => {
    const r = resolveTheme({ overrides: { accent: '#f6c453', radius: 99 }, live }, widgetTokens);
    expect(r.adjusted).toBe(true);
    expect(r.accent).not.toBe('#f6c453');
    expect(r.vars).toContain('--kaki-radius:20px');
  });

  it('honours the font choices and never lets a family break out of the declaration', () => {
    const sys = resolveTheme({ overrides: { font: { kind: 'system' } }, live }, widgetTokens);
    expect(sys.vars).toContain(`--kaki-font:${tokenValue(widgetTokens.light, 'font')}`);
    const custom = resolveTheme(
      { overrides: { font: { kind: 'custom', family: 'Inter' } }, live },
      widgetTokens,
    );
    expect(custom.vars).toMatch(/--kaki-font:"Inter", system-ui/);
    const evil = resolveTheme(
      { overrides: {}, live: { ...live, font: 'x;}:host{display:none' } },
      widgetTokens,
    );
    expect(evil.vars).not.toContain('display:none');
  });
});

describe('detection helpers', () => {
  it('picks the most frequent saturated colour, skipping greys and transparent', () => {
    expect(
      pickSaturated([
        'rgb(255, 255, 255)',
        'rgb(194, 65, 12)',
        'rgba(0, 0, 0, 0)',
        'rgb(29, 78, 216)',
        'rgb(194, 65, 12)',
        'rgb(120, 120, 120)',
      ]),
    ).toBe('#c2410c');
    expect(pickSaturated(['rgb(0, 0, 0)', 'rgb(240, 240, 240)'])).toBeNull();
  });

  it('takes the median radius, clamped 0–20', () => {
    expect(medianRadius([4, 6, 40])).toBe(6);
    expect(medianRadius([30, 40])).toBe(20);
    expect(medianRadius([4, 8])).toBe(6);
    expect(medianRadius([NaN])).toBeNull();
  });

  it('skips icon, decorative and generic fonts', () => {
    expect(pickFont('"Font Awesome 6 Free", "Lora", serif')).toBe('Lora');
    expect(pickFont('Material Icons, sans-serif')).toBeNull();
    expect(pickFont('-apple-system, "Segoe UI", Roboto')).toBe('Segoe UI');
  });

  it('reads the scheme from the background, else the colour-scheme', () => {
    expect(schemeOf('rgb(18, 26, 34)', null)).toBe('dark');
    expect(schemeOf('rgb(255, 255, 255)', 'dark')).toBe('light');
    expect(schemeOf(null, 'dark')).toBe('dark');
    expect(schemeOf(null, 'light dark')).toBe('light');
  });
});
