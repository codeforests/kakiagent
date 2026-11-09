/** The Telegram channel (CHN-05, CHN-12, LED-04; FEAT-037 §5). */
export {
  classifyTelegram,
  redactBotToken,
  TELEGRAM_API_BASE,
  TelegramApiError,
  telegramApi,
  type TelegramApi,
  type TelegramApiOptions,
  type TelegramFailure,
  type TelegramUser,
  type WebhookInfo,
} from './api.js';
export {
  CONTENT_LABELS,
  displayName,
  normaliseUpdate,
  OTHER_CONTENT,
  TelegramUpdate,
  telegramOf,
  TEXT_MAX,
  type TelegramExtensions,
} from './parse.js';
export { blockChange, telegramIgnoreReason, type TelegramIgnore } from './ignore.js';
export { TELEGRAM_CAPABILITIES } from './capabilities.js';
export {
  botIdOf,
  credentialAad,
  NoCredentialError,
  openTelegram,
  sealTelegram,
  secretHash,
  secretMatches,
  type TelegramCredential,
} from './credential.js';
export {
  SECRET_HEADER,
  sendFailure,
  telegramAdapter,
  type TelegramAdapterDeps,
} from './adapter.js';
