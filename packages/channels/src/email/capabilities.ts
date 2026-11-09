import type { ChannelCapabilities } from '../adapter.js';

/** Email (FEAT-036 §5.1): no streaming, no rich content, attachments in. */
export const EMAIL_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  maxLength: 20000,
  richContent: false,
  attachments: true,
  typing: false,
};
