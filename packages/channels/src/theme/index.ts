/**
 * Widget theme detection, contrast clamp and resolution (CHN-14, ADR-016; FEAT-032 §5.1).
 * DOM-only: bundled by the loader and the preview, built as `detect.js` for the
 * ingest-worker's Chromium, and used by the dashboard for the "adjusted" note (D4).
 */
export { contrast, luminance, parseColour, toHex, toOklch, fromOklch, type Rgb } from './colour.js';
export { clampAccent, tokenValue, type Scheme } from './clamp.js';
export {
  detectTheme,
  medianRadius,
  pickFont,
  pickSaturated,
  schemeOf,
  type LiveTheme,
} from './detect.js';
export {
  resolveTheme,
  type ResolvedTheme,
  type StoredTheme,
  type ThemeOverridesInput,
} from './resolve.js';
