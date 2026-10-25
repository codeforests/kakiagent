/**
 * The widget's look on the host page (CHN-14, ADR-016; FEAT-032 §5.2): the shadow host's
 * positioning, the one token sheet that is swapped when the theme changes, and live
 * following of the page between light and dark. Shared by the loader and the preview.
 */
import type { WidgetPosition, WidgetTheme } from '@kaki/contracts';
import {
  detectTheme,
  resolveTheme,
  type LiveTheme,
  type ResolvedTheme,
} from '@kaki/channels/theme';
import { widgetTokens } from '@kaki/design-tokens/widget';

/** Inline `!important` positioning, restored if the host page rewrites it (ADR-016 d2). */
export function hostStyle(position: WidgetPosition): string {
  return (
    `position:fixed!important;${position}:var(--kaki-edge-offset,20px)!important;bottom:var(--kaki-edge-offset,20px)!important;` +
    'z-index:2147483000!important;display:block!important;width:auto!important;height:auto!important;margin:0!important;padding:0!important;'
  );
}

/** Override > live > stored > default, clamped (ADR-016 decision 4, D5). */
export function resolved(theme: WidgetTheme, live: LiveTheme | null): ResolvedTheme {
  return resolveTheme({ overrides: theme.overrides, live, stored: theme.detected }, widgetTokens);
}

export const hostSheetCss = (r: ResolvedTheme) => `:host{all:initial;${r.vars}}`;

interface SheetLike {
  replaceSync(css: string): void;
}
interface ShadowLike {
  adoptedStyleSheets?: SheetLike[];
  prepend(node: unknown): void;
}

/**
 * One token sheet, first in the shadow root; `set` replaces its text, so swapping tokens
 * re-renders nothing (§5.2). Falls back to a `<style>` where constructable sheets are missing.
 */
export function tokenSheet(
  shadow: ShadowLike,
  env: {
    Sheet?: (new () => SheetLike) | undefined;
    createStyle?: () => { textContent: string | null };
  } = {
    Sheet: typeof CSSStyleSheet === 'function' ? CSSStyleSheet : undefined,
    createStyle: () => document.createElement('style'),
  },
): { set(css: string): void } {
  if (env.Sheet && 'adoptedStyleSheets' in shadow) {
    const sheet = new env.Sheet();
    shadow.adoptedStyleSheets = [sheet, ...(shadow.adoptedStyleSheets ?? [])];
    return { set: (css) => sheet.replaceSync(css) };
  }
  const style = env.createStyle!();
  shadow.prepend(style);
  return {
    set: (css) => {
      style.textContent = css;
    },
  };
}

/** Re-detects the page when it switches between light and dark (debounced 150 ms). */
export function followPage(onChange: (live: LiveTheme) => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(detectTheme(document, window)), 150);
  };
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', run);
  const watch = new MutationObserver(run);
  const attributeFilter = ['class', 'style', 'data-theme', 'data-mode', 'data-color-scheme'];
  watch.observe(document.documentElement, { attributes: true, attributeFilter });
  if (document.body) watch.observe(document.body, { attributes: true, attributeFilter });
}
