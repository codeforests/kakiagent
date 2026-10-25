/**
 * The ChannelAdapter contract (ADR-011). The core never branches on channel kind; it
 * talks to adapters through this interface. The skeleton defines the contract and the
 * widget origin rule; FEAT-034+ implement adapters with contract tests (CHN-01). FEAT-032
 * adds the website widget's settings (`widget-settings.ts`) and the theme module.
 */
export type ChannelKind = 'widget' | 'email' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';

export interface InboundMessage {
  channel: ChannelKind;
  externalId: string;
  contactRef: string;
  text: string;
  receivedAt: Date;
}

export interface OutboundMessage {
  idempotencyKey: string;
  contactRef: string;
  text: string;
}

export interface ChannelAdapter {
  kind: ChannelKind;
  /** Turns a provider payload into zero or more inbound messages (ignore rules apply). */
  normalise(payload: unknown): InboundMessage[];
  /** Sends one message; must be idempotent on `idempotencyKey`. */
  send(msg: OutboundMessage): Promise<{ externalId: string }>;
}

/**
 * CHN-11: the widget works only on allowed origins. Exact match on scheme, host and
 * port after URL normalisation; no wildcards (FEAT-032 D3, `normaliseOrigin`).
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    return false;
  }
  return allowed.some((a) => {
    try {
      return new URL(a).origin === normalised;
    } catch {
      return false;
    }
  });
}

export { InvalidOriginError, normaliseOrigin } from './origin.js';
export {
  addOrigin,
  clearLogo,
  DETECT_RUNNING_MS,
  DetectRunningError,
  getWidgetSettings,
  installCheckOf,
  LogoTooLargeError,
  LogoTypeError,
  logoUrlOf,
  NoSiteError,
  OriginExistsError,
  OriginNotAllowedError,
  OriginNotFoundError,
  recordInstallSeen,
  recordRejectedOrigin,
  removeOrigin,
  requestDetection,
  runThemeDetect,
  setAppearance,
  setLogo,
  snippetOf,
  TooManyOriginsError,
  visitorLogo,
  visitorWidgetTheme,
  type ThemeProbe,
  type WidgetContext,
  type WidgetUrls,
} from './widget-settings.js';
