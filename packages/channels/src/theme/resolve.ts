import { clampAccent, tokenValue, type Scheme } from './clamp.js';
import type { LiveTheme } from './detect.js';

type FontChoice = { kind: 'site' } | { kind: 'system' } | { kind: 'custom'; family: string };
export interface ThemeOverridesInput {
  accent?: string;
  font?: FontChoice;
  radius?: number;
  scheme?: Scheme;
}
export type StoredTheme = Pick<LiveTheme, 'accent' | 'font' | 'radius' | 'scheme'>;

export interface ResolvedTheme {
  scheme: Scheme;
  /** `--kaki-*` declarations: the scheme's defaults, then the resolved values. */
  vars: string;
  accent: string;
  /** True when the accent had to move for contrast (D5). */
  adjusted: boolean;
}

const safeFamily = (f: string | null | undefined) => {
  const v = (f ?? '').replace(/["']/g, '').trim();
  return v && /^[\w -]+$/.test(v) ? `"${v}"` : null;
};

/**
 * Per token: override > live > stored > default (ADR-016 decision 4). The accent is always
 * clamped, overrides too (D5); radius is capped 0–20; fonts never download.
 */
export function resolveTheme(
  input: { overrides: ThemeOverridesInput; live?: LiveTheme | null; stored?: StoredTheme | null },
  defaults: { light: string; dark: string },
): ResolvedTheme {
  const { overrides: o, live, stored } = input;
  const scheme: Scheme = o.scheme ?? live?.scheme ?? stored?.scheme ?? 'light';
  const base = defaults[scheme];
  const { accent, onAccent, adjusted } = clampAccent(
    o.accent ?? live?.accent ?? stored?.accent ?? tokenValue(base, 'accent'),
    scheme,
  );
  const stack = tokenValue(base, 'font');
  const kind = o.font?.kind ?? 'site';
  const family =
    kind === 'custom'
      ? safeFamily((o.font as { family: string }).family)
      : kind === 'site'
        ? safeFamily(live?.font ?? stored?.font)
        : null;
  const r = o.radius ?? live?.radius ?? stored?.radius;
  const radius = r == null || !Number.isFinite(r) ? null : Math.round(Math.max(0, Math.min(20, r)));
  const vars = [
    base,
    `--kaki-accent:${accent}`,
    `--kaki-on-accent:${onAccent}`,
    `--kaki-font:${family ? `${family}, ${stack}` : stack}`,
    ...(radius === null ? [] : [`--kaki-radius:${radius}px`]),
  ].join(';');
  return { scheme, vars, accent, adjusted };
}
