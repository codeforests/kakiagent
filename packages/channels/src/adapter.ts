/**
 * The ChannelAdapter contract (ADR-011, CHN-01). The core never branches on channel kind:
 * it consumes canonical `InboundEvent`s and emits `OutboundMessage`s, and a capability-aware
 * shaper (FEAT-036) adapts them to each channel. A new channel is an adapter module plus a
 * registry entry (`registry.ts`); `@kaki/channels/contract-suite` is the test every adapter
 * passes.
 */
export const CHANNEL_KINDS = [
  'widget',
  'email',
  'telegram',
  'messenger',
  'instagram',
  'whatsapp',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type ChannelHealthReason =
  'credential_revoked' | 'credential_invalid' | 'unreachable' | 'send_rejected';

export interface ChannelCapabilities {
  streaming: boolean;
  /** Longest text one message may carry; the shaper splits above it. */
  maxLength: number;
  richContent: boolean;
  attachments: boolean;
  /** Meta and WhatsApp: how long after the visitor's last message a free-form reply is allowed. */
  replyWindow?: { hours: number } | undefined;
  typing: boolean;
}

/** A sealed credential (`secrets.ts`) and the connection it belongs to. */
export interface CredentialRef {
  connectionId: string;
  tenantId: string;
  ciphertext: Uint8Array | null;
  keyRef: string | null;
}

/** A webhook request as the generic `/hooks/:kind/:connectionId` route received it. */
export interface RawInbound {
  headers: Record<string, string | undefined>;
  body: string;
  receivedAt: Date;
}

export interface VerifiedInbound {
  /** The provider's message or delivery ID: the idempotency key for `inbound_events`. */
  providerEventId: string;
  payload: unknown;
  receivedAt: Date;
}

export interface Rejection {
  rejected: 'bad_signature' | 'unknown_connection' | 'malformed';
}

export interface InboundAttachment {
  name: string;
  contentType: string;
  /** Where the adapter stored it (an S3 key once scanned), never the bytes. */
  ref: string;
}

export interface InboundEvent {
  kind: 'message' | 'postback' | 'delivery';
  tenantId: string;
  connectionId: string;
  externalUserId: string;
  text: string | null;
  attachments: InboundAttachment[];
  localeHint: string | null;
  timestamp: Date;
  /** Channel-specific data the core passes through without interpreting (ADR-011). */
  extensions: Record<string, unknown>;
}

export type IgnoreReason = 'auto_reply' | 'group' | 'bulk' | 'echo' | 'unsupported';

export type ExternalThreadKey = string;

export interface OutboundMessage {
  /** Idempotency key: `send` twice with one ID delivers once. */
  id: string;
  text: string;
  quickReplies?: string[] | undefined;
}

export interface SendContext {
  tenantId: string;
  connectionId: string;
  threadKey: ExternalThreadKey;
  credential: CredentialRef;
}

export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; failed: 'auth' | 'transient' | 'permanent'; status?: number | undefined };

export type HealthStatus = { ok: true } | { ok: false; reason: ChannelHealthReason };

export interface VerifiedSegment {
  messageId: string;
  index: number;
  text: string;
}

export interface ConnectRequest {
  tenantId: string;
  input: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  /** Signatures, tokens, origins. */
  verifyInbound(req: RawInbound, creds: CredentialRef): Promise<VerifiedInbound | Rejection>;
  /** → canonical messages, postbacks, delivery receipts. */
  normalise(v: VerifiedInbound, creds: CredentialRef): Promise<InboundEvent[]>;
  /** Auto-replies, groups, bulk mail, echoes (CHN-05, CHN-10). */
  shouldIgnore(e: InboundEvent): IgnoreReason | null;
  threadKey(e: InboundEvent): ExternalThreadKey;
  /** Idempotent on `msg.id`. */
  send(msg: OutboundMessage, ctx: SendContext): Promise<SendResult>;
  /** Only when `capabilities.streaming`. */
  stream?(seg: VerifiedSegment, ctx: SendContext): Promise<void>;
  checkHealth(creds: CredentialRef): Promise<HealthStatus>;
  connect?(setup: ConnectRequest): Promise<CredentialRef>;
}

export function isRejection(v: VerifiedInbound | Rejection): v is Rejection {
  return 'rejected' in v;
}
