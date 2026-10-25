import type {
  DetectFailure,
  Detection,
  FontChoice,
  InstallCheck,
  ThemeOverrides,
  WidgetPosition,
  WidgetSettings,
  WidgetTheme,
} from '@kaki/contracts';
import { clampAccent, tokenValue, type Scheme } from '@kaki/channels/theme';
import { widgetTokens } from '@kaki/design-tokens/widget';
import { relativeTime } from './coach.ts';

/** Copy and helpers for the website widget screens (FEAT-032 ui-design, SCR-APP-037/011). */

/** The editable part of the widget's look; logo uploads save on their own. */
export interface AppearanceDraft {
  position: WidgetPosition;
  overrides: ThemeOverrides;
}

export const draftOf = (theme: WidgetTheme): AppearanceDraft => ({
  position: theme.position,
  overrides: theme.overrides,
});

/** Key order differs between the server's JSON and the form's spreads. */
function canonical(d: AppearanceDraft) {
  const o = d.overrides;
  return JSON.stringify([d.position, o.accent, o.font, o.radius, o.scheme]);
}
export const sameDraft = (a: AppearanceDraft, b: AppearanceDraft) => canonical(a) === canonical(b);

/** Sets or clears one override (`undefined` follows the site). */
export function withOverride<K extends keyof ThemeOverrides>(
  d: AppearanceDraft,
  key: K,
  value: ThemeOverrides[K] | undefined,
): AppearanceDraft {
  const overrides = { ...d.overrides };
  if (value === undefined) delete overrides[key];
  else overrides[key] = value;
  return { ...d, overrides };
}

/** "Reset to my website": clears the overrides, keeps position (and the logo). */
export const resetDraft = (d: AppearanceDraft): AppearanceDraft => ({
  position: d.position,
  overrides: {},
});

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The widget's default accent per scheme (tokens.json `widget.accent`). */
export const defaultAccent = (scheme: Scheme) =>
  tokenValue(widgetTokens[scheme], 'accent').toLowerCase();

/** The scheme the preview shows first: the owner's fixed one, else the site's, else light. */
export const previewScheme = (theme: Pick<WidgetTheme, 'overrides' | 'detected'>): Scheme =>
  theme.overrides.scheme ?? theme.detected?.scheme ?? 'light';

/** "Adjusted to {hex} so text stays readable." when the clamp moves the colour (D5). */
export function adjustedNote(hex: string, scheme: Scheme): string | null {
  const { accent, adjusted } = clampAccent(hex, scheme);
  return adjusted ? `Adjusted to ${accent} so text stays readable.` : null;
}

export const HEX_INPUT = /^#[0-9a-fA-F]{6}$/;

/** "Match my website (…)" labels; "(not checked yet)" before any detection. */
export function matchLabel(theme: WidgetTheme, part: 'accent' | 'font' | 'radius'): string {
  const d = theme.detected;
  if (!d) return 'Match my website (not checked yet)';
  const value =
    part === 'accent'
      ? d.accent
      : part === 'font'
        ? d.font
        : d.radius === null
          ? null
          : `${Math.round(d.radius)} px`;
  return value === null ? 'Match my website (not found)' : `Match my website (${value})`;
}

export type FontOption = FontChoice['kind'];
export const fontOption = (o: ThemeOverrides): FontOption => o.font?.kind ?? 'site';

export const RADIUS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Square (0 px)' },
  { value: 6, label: 'Slightly rounded (6 px)' },
  { value: 12, label: 'Rounded (12 px)' },
  { value: 20, label: 'Very rounded (20 px)' },
];

/** The install-check chip: tone and text; colour is never the only signal. */
export function installChip(install: InstallCheck): {
  tone: 'neutral' | 'success' | 'warning';
  text: string;
} {
  if (install.state === 'detected' && install.origin)
    return { tone: 'success', text: `Installed on ${hostOf(install.origin)}` };
  if (install.state === 'wrong_domain' && install.rejectedOrigin)
    return {
      tone: 'warning',
      text: `Loaded on ${hostOf(install.rejectedOrigin)}, which isn't allowed`,
    };
  return { tone: 'neutral', text: 'Waiting for your website' };
}

/** The line under the chip (the `wrong_domain` alert is rendered by the page). */
export function installLine(install: InstallCheck, now = new Date()): string {
  if (install.state === 'detected' && install.lastSeenAt)
    return `Last seen ${relativeTime(install.lastSeenAt, now)}.`;
  return 'Once the line is on your website, open any page and this turns green.';
}

/** Poll every 5 s while the install check or a detection is still moving (D8). */
export const POLL_MS = 5000;
export function pollInterval(s: WidgetSettings | undefined): number | false {
  if (!s) return false;
  const moving =
    s.install.state !== 'detected' ||
    s.detection.status === 'queued' ||
    s.detection.status === 'running';
  return moving ? POLL_MS : false;
}

export const detecting = (d: Detection) => d.status === 'queued' || d.status === 'running';

export const FAILURE_COPY: Record<DetectFailure, (host: string) => string> = {
  unreachable: (h) => `We couldn't open ${h}.`,
  blocked: (h) => `${h} isn't a public website we can open.`,
  timeout: (h) => `${h} took too long to load.`,
  no_page: (h) => `${h} didn't return a page.`,
};

const DATE = new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });

/** The caption under the preview; null when nothing was ever requested. */
export function detectionCopy(
  s: Pick<WidgetSettings, 'detection' | 'theme' | 'siteUrl'>,
): string | null {
  const { detection, theme } = s;
  if (detecting(detection)) return 'Matching your website…';
  if (detection.status === 'failed')
    return FAILURE_COPY[detection.failure ?? 'unreachable'](hostOf(s.siteUrl ?? ''));
  if (theme.detected)
    return `Matched to ${hostOf(theme.detected.url)} on ${DATE.format(new Date(theme.detected.detectedAt))}`;
  return null;
}

/** Inline errors for "Add a website" (ui-design OriginsList). */
export function originError(code: string, host: string): string {
  switch (code) {
    case 'invalid_origin':
      return 'Enter a website address like shop.example.sg. Use https, and list each subdomain.';
    case 'origin_exists':
      return `${host} is already on the list.`;
    case 'too_many_origins':
      return 'You can add up to 20 websites.';
    default:
      return "We couldn't add that website. Try again.";
  }
}

export const LOGO_ERROR: Record<string, string> = {
  logo_too_large: 'That file is over 100 KB.',
  logo_type: 'Use a PNG, JPG or WebP image.',
};

export type Platform = 'wordpress' | 'wix' | 'shopify' | 'html';
export const PLATFORMS: { id: Platform; label: string; steps: string[] }[] = [
  {
    id: 'wordpress',
    label: 'WordPress',
    steps: [
      'In WordPress, open Appearance → Theme File Editor, or use a header-scripts plugin such as WPCode.',
      'Paste the line just before </body>.',
      'Save, then open your website.',
    ],
  },
  {
    id: 'wix',
    label: 'Wix',
    steps: [
      'In Wix, open Settings → Custom code.',
      'Click Add custom code, paste the line, and choose All pages, Body - end.',
      'Publish your site.',
    ],
  },
  {
    id: 'shopify',
    label: 'Shopify',
    steps: [
      'In Shopify, open Online Store → Themes → … → Edit code.',
      'Open theme.liquid and paste the line just before </body>.',
      'Save.',
    ],
  },
  {
    id: 'html',
    label: 'HTML',
    steps: [
      'Paste the line just before </body> on every page.',
      'Upload the pages to your website.',
    ],
  },
];

/** The dashboard → preview iframe message (FEAT-032 §5.3; validated by the widget). */
export interface PreviewMessage {
  type: 'kaki-preview';
  theme: WidgetTheme;
  botName: string;
  greeting: string;
  scheme: Scheme;
  site: { background: string | null; font: string | null };
}

export function previewMessage(
  theme: WidgetTheme,
  draft: AppearanceDraft,
  scheme: Scheme,
  assistant: { botName: string; greeting: string },
): PreviewMessage {
  return {
    type: 'kaki-preview',
    theme: { ...theme, position: draft.position, overrides: draft.overrides },
    botName: assistant.botName,
    greeting: assistant.greeting,
    scheme,
    site: { background: null, font: theme.detected?.font ?? null },
  };
}

/**
 * The preview iframe is sandboxed without `allow-same-origin`, so its origin is opaque and
 * a message can only be posted to `*`; it carries nothing private (the look, the bot's name
 * and greeting). Its replies are matched on `event.source`.
 */
export const PREVIEW_TARGET = '*';

export const isPreviewReady = (data: unknown) =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'kaki-preview-ready';
