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
export {
  connectTelegram,
  disconnectTelegram,
  replaceTelegramToken,
  TelegramChannelError,
  telegramChannelView,
  telegramCredentialOf,
  type TelegramChannelErrorCode,
  type TelegramSettingsDeps,
} from './settings.js';
export {
  codeHash,
  LINK_CODE,
  linkPending,
  queueServiceReply,
  receiveTelegram,
  TEXT_ONLY_NOTICE,
  telegramVisitorId,
  type TelegramInboxPort,
  type TelegramReceiveDeps,
  type TelegramReceiveResult,
  type TelegramTexts,
} from './receive.js';
export {
  SERVICE_GIVE_UP_MS,
  sendServiceJob,
  ServiceRetryError,
  type ServiceOutcome,
  type TelegramServiceDeps,
} from './service.js';
export { telegramSender, type TelegramSenderConfig } from './send.js';
