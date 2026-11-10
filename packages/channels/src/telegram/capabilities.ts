import type { ChannelCapabilities } from '../adapter.js';

/**
 * Telegram (FEAT-037 §5.1): plain text up to 4,096, no cards, no attachments out, no typing
 * yet. The GOV-14 privacy line goes only on the message with the AI disclosure (D7).
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  maxLength: 4096,
  richContent: false,
  attachments: false,
  typing: false,
  footer: 'with_disclosure',
};
