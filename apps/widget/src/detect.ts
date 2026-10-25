/**
 * `detect.js` (FEAT-032 §5.4, D4): the loader's own theme detection as a classic script,
 * which the ingest-worker evaluates in the tenant's page. Sets `window.__kakiDetect`.
 */
import { detectTheme } from '@kaki/channels/theme';

(window as unknown as { __kakiDetect: typeof detectTheme }).__kakiDetect = detectTheme;
