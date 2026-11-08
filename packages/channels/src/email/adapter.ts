/**
 * The email `ChannelAdapter` (ADR-011; FEAT-036 §5.1). Inbound mail arrives as an SES
 * notification on SNS; `verifyInbound` trusts only our topic and bucket, `normalise` fetches
 * and parses the raw mail into one canonical event. The production paths are
 * `receiveEmail` (which also writes the inbox rows) and `emailSender` through
 * `deliverMessage` (D2); this adapter is the same logic behind the contract every channel
 * passes, plus `checkHealth`, which the health job calls.
 */
import type {
  ChannelAdapter,
  CredentialRef,
  HealthStatus,
  IgnoreReason,
  InboundEvent,
  OutboundMessage,
  RawInbound,
  Rejection,
  SendContext,
  SendResult,
  VerifiedInbound,
} from '../adapter.js';
import { EMAIL_CAPABILITIES } from './capabilities.js';
import { ignoreReason } from './ignore.js';
import { bodyText, parseEmail } from './parse.js';
import { verifySnsEnvelope, type InboundEmailConfig } from './receive.js';
import { threadKey } from './thread.js';

export interface EmailAdapterDeps {
  config: Pick<InboundEmailConfig, 'topicArn' | 'inboundBucket'>;
  /** The raw MIME SES stored (S3 in the workers). */
  getRaw(bucket: string, key: string): Promise<Uint8Array>;
  /** The tenant's own addresses (forwarding and reply-from), lower case: echoes. */
  ownAddresses?(tenantId: string): Promise<readonly string[]>;
  /** Sends one reply, idempotent on `msg.id` (the workers bind `emailSender` in a tenant tx). */
  send(msg: OutboundMessage, ctx: SendContext): Promise<SendResult>;
  /** The custom domain check (`checkEmailDomain`); forwarding only → ok. */
  checkDomain(tenantId: string): Promise<HealthStatus>;
}

/** CHN-10's email reasons onto the adapter contract's (`list` and `loop` are bulk). */
const IGNORE: Record<string, IgnoreReason> = {
  auto_reply: 'auto_reply',
  bounce: 'bounce',
  bulk: 'bulk',
  list: 'bulk',
  loop: 'bulk',
  spam: 'spam',
  unsafe: 'unsafe',
  echo: 'echo',
};

interface SesPayload {
  receipt?: {
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { bucketName?: string; objectKey?: string };
  };
  notificationType?: string;
}

export function emailAdapter(deps: EmailAdapterDeps): ChannelAdapter {
  return {
    kind: 'email',
    capabilities: EMAIL_CAPABILITIES,
    async verifyInbound(req: RawInbound): Promise<VerifiedInbound | Rejection> {
      let body: unknown;
      try {
        body = JSON.parse(req.body);
      } catch {
        return { rejected: 'malformed' };
      }
      const v = verifySnsEnvelope(body, deps.config);
      if (!v.ok) return { rejected: v.rejected };
      const id = v.ses.mail?.messageId;
      if (!id || v.ses.notificationType !== 'Received') return { rejected: 'malformed' };
      return { providerEventId: id, payload: v.ses, receivedAt: req.receivedAt };
    },
    async normalise(v: VerifiedInbound, creds: CredentialRef): Promise<InboundEvent[]> {
      const ses = v.payload as SesPayload;
      const action = ses.receipt?.action;
      if (!action?.bucketName || !action.objectKey) return [];
      const p = await parseEmail(
        Buffer.from(await deps.getRaw(action.bucketName, action.objectKey)),
      );
      if (!p.from) return [];
      const ignore = ignoreReason(p, {
        ownMessage: false,
        ownAddresses: (await deps.ownAddresses?.(creds.tenantId)) ?? [],
        verdicts: {
          spam: ses.receipt?.spamVerdict?.status,
          virus: ses.receipt?.virusVerdict?.status,
          dmarc: ses.receipt?.dmarcVerdict?.status,
        },
      });
      return [
        {
          kind: 'message',
          tenantId: creds.tenantId,
          connectionId: creds.connectionId,
          externalUserId: p.from.address,
          text: bodyText(p),
          attachments: p.attachments.map((a) => ({
            name: a.name,
            contentType: a.contentType,
            ref: '',
          })),
          localeHint: null,
          timestamp: p.date ?? v.receivedAt,
          extensions: {
            subject: p.subject,
            messageId: p.messageId,
            threadKey: threadKey(p),
            ignore,
          },
        },
      ];
    },
    shouldIgnore(e: InboundEvent): IgnoreReason | null {
      const r = e.extensions.ignore;
      return typeof r === 'string' ? (IGNORE[r] ?? 'unsupported') : null;
    },
    threadKey(e: InboundEvent) {
      const k = e.extensions.threadKey;
      return typeof k === 'string' && k ? k : `${e.connectionId}:${e.externalUserId}`;
    },
    send: (msg, ctx) => deps.send(msg, ctx),
    checkHealth: (creds) => deps.checkDomain(creds.tenantId),
  };
}
