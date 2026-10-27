/**
 * Channels (ADR-011, CHN-01). The ADR-011 adapter contract (`adapter.ts`), the registry
 * that makes a new channel an adapter plus an entry (`registry.ts`), connections with their
 * live/offline state and health (`connections.ts`, FEAT-034), sealed credentials
 * (`secrets.ts`), and the website widget's settings and theme (FEAT-032). The contract-test
 * suite is the test-only `@kaki/channels/contract-suite` export.
 */
export {
  CHANNEL_KINDS,
  isRejection,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHealthReason,
  type ChannelKind,
  type ConnectRequest,
  type CredentialRef,
  type ExternalThreadKey,
  type HealthStatus,
  type IgnoreReason,
  type InboundAttachment,
  type InboundEvent,
  type OutboundMessage,
  type RawInbound,
  type Rejection,
  type SendContext,
  type SendResult,
  type VerifiedInbound,
  type VerifiedSegment,
} from './adapter.js';
export {
  CHANNEL_REGISTRY,
  connectable,
  registryEntry,
  type ChannelRegistry,
  type ChannelRegistryEntry,
  type OfflineMode,
} from './registry.js';
export { localSealer, SealError, type SecretSealer } from './secrets.js';

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
