import { describe, expect, it } from 'vitest';
import {
  AttachmentScanJob,
  ChannelSendJob,
  ConversationListQuery,
  ConversationSummary,
  DeliveryFailedJob,
  EmailChannelResponse,
  EmailDomainBody,
  EmailReplyCapBody,
  EscalationSource,
  Message,
  TurnQueueJob,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';

describe('email channel contracts (FEAT-036 §3)', () => {
  it('round-trips a message with a delivery and attachments; widget messages need neither', () => {
    const base = {
      id: ID,
      conversationId: ID,
      seq: 4,
      author: 'agent',
      body: 'Yes, we deliver.',
      inReplyTo: null,
      disclosure: null,
      notice: null,
      noticeKind: null,
      authorName: null,
      language: 'en',
      createdAt: AT,
    } as const;
    expect(Message.parse(base)).toEqual(base);
    const email = {
      ...base,
      delivery: { status: 'failed', failedReason: 'timed_out', sentAt: null },
      attachments: [
        {
          id: ID,
          name: 'menu.pdf',
          contentType: 'application/pdf',
          size: 1024,
          status: 'rejected',
          rejectReason: 'malware',
        },
      ],
    } as const;
    expect(Message.parse(email)).toEqual(email);
    expect(
      Message.safeParse({ ...base, delivery: { status: 'lost', failedReason: null, sentAt: null } })
        .success,
    ).toBe(false);
  });

  it('widens the channel, adds the subject and the two escalation sources', () => {
    expect(ConversationListQuery.parse({ channel: 'email' }).channel).toBe('email');
    expect(ConversationListQuery.safeParse({ channel: 'messenger' }).success).toBe(false);
    const summary = ConversationSummary.parse({
      id: ID,
      channel: 'email',
      subject: 'Birthday cake',
      status: 'ai',
      lastMessageAt: AT,
      lastMessage: 'Hi',
      flaggedAt: null,
      flagReasons: [],
      closeReason: null,
      closedAt: null,
      owner: null,
      escalation: null,
    });
    expect(summary.subject).toBe('Birthday cake');
    expect(EscalationSource.parse('reply_cap')).toBe('reply_cap');
    expect(EscalationSource.parse('delivery_failed')).toBe('delivery_failed');
  });

  it('round-trips the channel response', () => {
    const res = {
      connected: true,
      connection: { id: ID, state: 'offline', version: 1 },
      forwardingAddress: 'kaki-bakery@in.kaki.test',
      lastReceivedAt: null,
      forwardingConfirmation: {
        code: '123456789',
        link: 'https://mail.google.com/x',
        receivedAt: AT,
      },
      replyFrom: 'kaki-bakery@in.kaki.test',
      domain: {
        address: 'hello@kakibakery.test',
        domain: 'kakibakery.test',
        state: 'pending',
        checkedAt: null,
        verifiedAt: null,
        failingSince: null,
        records: [
          {
            purpose: 'dkim',
            type: 'CNAME',
            host: 'a._domainkey.kakibakery.test',
            value: 'a.dkim.amazonses.com',
            status: 'pending',
          },
        ],
      },
      replyCap: 10,
      ignored: [{ reason: 'auto_reply', count: 2 }],
      settingsVersion: 3,
    } as const;
    expect(EmailChannelResponse.parse(res)).toEqual(res);
    expect(
      EmailChannelResponse.safeParse({ ...res, ignored: [{ reason: 'virus', count: 1 }] }).success,
    ).toBe(false);
  });

  it('the reply cap is 1–50 and the domain body is an address', () => {
    expect(EmailReplyCapBody.safeParse({ replyCap: 3, settingsVersion: 1 }).success).toBe(true);
    expect(EmailReplyCapBody.safeParse({ replyCap: 0, settingsVersion: 1 }).success).toBe(false);
    expect(EmailReplyCapBody.safeParse({ replyCap: 51, settingsVersion: 1 }).success).toBe(false);
    expect(
      EmailDomainBody.safeParse({ address: 'hello@kakibakery.test', settingsVersion: 1 }).success,
    ).toBe(true);
    expect(
      EmailDomainBody.safeParse({ address: 'kakibakery.test', settingsVersion: 1 }).success,
    ).toBe(false);
  });

  it('parses the new queue jobs', () => {
    expect(ChannelSendJob.parse({ tenantId: ID, messageId: ID })).toEqual({
      tenantId: ID,
      messageId: ID,
    });
    const failed = {
      kind: 'delivery_failed',
      tenantId: ID,
      conversationId: ID,
      messageId: ID,
    } as const;
    expect(DeliveryFailedJob.parse(failed)).toEqual(failed);
    expect(TurnQueueJob.parse(failed)).toEqual(failed);
    expect(
      AttachmentScanJob.parse({ kind: 'attachment_scan', tenantId: ID, attachmentId: ID }).kind,
    ).toBe('attachment_scan');
  });
});
