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
  type InboxPort,
  type ReceiveDeps,
  type ReceiveResult,
  type RecipientOutcome,
} from './receive.js';
export { lookupIds, replySubject, threadKey, threadSubject } from './thread.js';
export { EMAIL_CAPABILITIES } from './capabilities.js';
export {
  classifySmtp,
  emailSender,
  quoteName,
  replyAddressOf,
  type EmailSenderConfig,
} from './send.js';
export { emailAdapter, type EmailAdapterDeps } from './adapter.js';
export {
  checkEmailDomain,
  withEmailHealth,
  type DomainCheckDeps,
  type DomainCheckResult,
} from './domain.js';
export {
  allPass,
  checkDomain,
  domainHealth,
  domainOf,
  FREE_MAIL_DOMAINS,
  fixtureIdentities,
  fixtureTxtResolver,
  hasDmarc,
  identityProvider,
  IdentityProviderError,
  nextDomainState,
  nodeTxtResolver,
  records,
  refusedDomain,
  sesIdentities,
  type DomainChecks,
  type IdentityProviderKind,
  type IdentityStatus,
  type SendingIdentities,
  type TxtResolver,
} from './identity.js';
export {
  cleanAttachment,
  clearDomain,
  DEFAULT_REPLY_CAP,
  DOMAIN_CHECK_MS,
  domainToAdd,
  domainToCheck,
  domainToRemove,
  EmailChannelError,
  emailChannelView,
  retryDelivery,
  saveReplyCap,
  setupEmail,
  storeDomain,
  type EmailSettingsConfig,
} from './settings.js';
