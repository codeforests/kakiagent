/** Channel handoff (CHN-07; FEAT-038): `@kaki/channels/handoff`. */
export {
  signHandoff,
  openHandoff,
  peekHandoff,
  HANDOFF_CODE,
  type HandoffLinkChannel,
} from './token.js';
export {
  buildRecap,
  maskEmail,
  RECAP_TELEGRAM_MESSAGES,
  RECAP_EMAIL_MESSAGES,
  type RecapInput,
  type RecapMessage,
} from './recap.js';
export {
  requestHandoff,
  handoffOptions,
  survivorOf,
  HANDOFF_TTL_MS,
  HANDOFF_LIMITS,
  type HandoffOptions,
  type HandoffRequestBody,
  type HandoffRequestResult,
} from './request.js';
export { MOVED_NOTICE, finishHandoff, lockLink, type HandoffLink } from './redeem.js';
export {
  sendHandoffEmail,
  confirmCodeTenant,
  viewEmailHandoff,
  confirmEmailHandoff,
  CONFIRM_SUBJECT,
  type HandoffEmailDeps,
  type HandoffEmailOutcome,
  type HandoffPageView,
} from './email.js';
export { purgeHandoffLinks } from './purge.js';
