import type { WidgetTheme } from '@kaki/contracts';

/**
 * The dashboard → preview iframe message (FEAT-032 §5.3, D6). Anything that doesn't
 * validate is ignored; the sender is checked against `window.parent` by the caller.
 * Checked by hand rather than with the contracts' Zod shapes, which would make the
 * preview bundle twenty times larger.
 */
export interface PreviewMessage {
  type: 'kaki-preview';
  theme: WidgetTheme;
  botName: string;
  greeting: string;
  /** The site's scheme the preview shows when the owner hasn't fixed one (light/dark toggle). */
  scheme?: 'light' | 'dark';
  /** The site's look for the mock page behind the widget. */
  site?: { background: string | null; font: string | null };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const FAMILY = /^[\w \-,'"]{1,100}$/;
const isScheme = (v: unknown) => v === 'light' || v === 'dark';
const isHex = (v: unknown) => typeof v === 'string' && HEX.test(v);
const onlyKeys = (o: Obj, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

function isFont(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (v.kind === 'site' || v.kind === 'system') return onlyKeys(v, ['kind']);
  return v.kind === 'custom' && typeof v.family === 'string' && FAMILY.test(v.family.trim());
}

function isOverrides(v: unknown): boolean {
  return (
    isObj(v) &&
    onlyKeys(v, ['accent', 'font', 'radius', 'scheme']) &&
    (v.accent === undefined || isHex(v.accent)) &&
    (v.font === undefined || isFont(v.font)) &&
    (v.radius === undefined ||
      (Number.isInteger(v.radius) && (v.radius as number) >= 0 && (v.radius as number) <= 20)) &&
    (v.scheme === undefined || isScheme(v.scheme))
  );
}

function isDetected(v: unknown): boolean {
  if (v === null) return true;
  return (
    isObj(v) &&
    (v.accent === null || isHex(v.accent)) &&
    (v.font === null || (typeof v.font === 'string' && v.font.length <= 200)) &&
    (v.radius === null || (typeof v.radius === 'number' && v.radius >= 0)) &&
    isScheme(v.scheme)
  );
}

function isTheme(v: unknown): v is WidgetTheme {
  return (
    isObj(v) &&
    (v.position === 'right' || v.position === 'left') &&
    isOverrides(v.overrides) &&
    isDetected(v.detected) &&
    (v.logoUrl === null || (typeof v.logoUrl === 'string' && /^https?:\/\//.test(v.logoUrl)))
  );
}

export function parsePreviewMessage(data: unknown): PreviewMessage | null {
  if (!isObj(data) || data.type !== 'kaki-preview' || !isTheme(data.theme)) return null;
  const botName = typeof data.botName === 'string' ? data.botName.trim() : '';
  if (!botName || botName.length > 30) return null;
  if (typeof data.greeting !== 'string' || data.greeting.length > 200) return null;
  if (data.scheme !== undefined && !isScheme(data.scheme)) return null;
  let site: PreviewMessage['site'];
  if (data.site !== undefined) {
    const s = data.site;
    if (!isObj(s)) return null;
    if (s.background !== null && !isHex(s.background)) return null;
    if (s.font !== null && !(typeof s.font === 'string' && /^[\w ,'"-]{0,200}$/.test(s.font)))
      return null;
    site = { background: s.background as string | null, font: s.font as string | null };
  }
  return {
    type: 'kaki-preview',
    theme: data.theme,
    botName,
    greeting: data.greeting,
    ...(data.scheme ? { scheme: data.scheme as 'light' | 'dark' } : {}),
    ...(site ? { site } : {}),
  };
}
