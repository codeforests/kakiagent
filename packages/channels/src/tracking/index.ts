/** Web context and first-party page tracking (CHN-03, AGT-05; FEAT-029): `@kaki/channels/tracking`. */
export { trackingMode, trackingColumns, visitorTrackingMode, setTrackingMode } from './settings.js';
export {
  recordEvents,
  trackingAllowed,
  clampViewedAt,
  maskPath,
  maskUtm,
  referrerHost,
  TRACK_CLOCK_SKEW_MS,
} from './events.js';
export { recordChoice, visitorChoice, NotConsentModeError, type TrackingChoice } from './choice.js';
export {
  webContextOf,
  distinctViews,
  PAGE_ONLY,
  WEB_WINDOW_MS,
  WEB_VIEWED_MAX,
} from './context.js';
export { purgeVisitorEvents } from './purge.js';
