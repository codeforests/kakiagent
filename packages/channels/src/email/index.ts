/** The email channel (CHN-04, CHN-10; FEAT-036 §5.1–§5.3). */
export { ignoreReason, type IgnoreContext, type SesVerdicts } from './ignore.js';
export {
  BODY_MAX,
  bodyText,
  forwardingConfirmation,
  NO_TEXT,
  parseEmail,
  type ParsedAttachment,
  type ParsedEmail,
} from './parse.js';
export {
  ATTACHMENT_LIMITS,
  emailVisitorId,
  LOOP_LIMIT,
  receiveEmail,
  verifySnsEnvelope,
  type InboundEmailConfig,
  type MailObjectStore,
  type EmailInboxPort,
  type ReceiveDeps,
  type ReceiveResult,
  type RecipientOutcome,
} from './receive.js';
export { lookupIds, replySubject, threadKey, threadSubject } from './thread.js';
export { EMAIL_CAPABILITIES } from './capabilities.js';
export { classifySmtp, emailSender, type EmailSenderConfig } from './send.js';
