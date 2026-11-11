import { describe, expect, it } from 'vitest';
import {
  HandoffBody,
  HandoffEmailJob,
  HandoffError,
  HandoffResponse,
  Message,
  MessageCard,
  WidgetConfigResponse,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';

describe('channel handoff contracts (FEAT-038 §3)', () => {
  it('round-trips the bodies, responses, error and job', () => {
    for (const body of [
      { channel: 'telegram' },
      { channel: 'email', email: 'siti@example.com' },
    ] as const)
      expect(HandoffBody.parse(body)).toEqual(body);
    for (const res of [
      { channel: 'telegram', url: 'https://t.me/kaki_bot?start=c-abc', expiresAt: AT },
      { channel: 'email', sentTo: 's***@example.com', expiresAt: AT },
    ] as const)
      expect(HandoffResponse.parse(res)).toEqual(res);
    const err = {
      error: 'moved',
      message: 'This chat continues on Telegram.',
      channel: 'telegram',
    };
    expect(HandoffError.parse(err)).toEqual(err);
    expect(HandoffError.safeParse({ error: 'gone', message: '' }).success).toBe(false);
    expect(HandoffEmailJob.parse({ tenantId: ID, linkId: ID })).toEqual({
      tenantId: ID,
      linkId: ID,
    });
  });

  it('refuses extra keys, an email on the Telegram body and an address over 254', () => {
    expect(HandoffBody.safeParse({ channel: 'telegram', email: 'a@b.co' }).success).toBe(false);
    expect(HandoffBody.safeParse({ channel: 'email', email: 'a@b.co', tenantId: ID }).success).toBe(
      false,
    );
    expect(HandoffBody.safeParse({ channel: 'email' }).success).toBe(false);
    expect(
      HandoffBody.safeParse({ channel: 'email', email: `${'a'.repeat(250)}@b.co` }).success,
    ).toBe(false);
    expect(HandoffBody.safeParse({ channel: 'whatsapp' }).success).toBe(false);
  });

  it('carries the handoff and moved cards, the notice kinds and the config flags', () => {
    const card = { kind: 'handoff', telegram: true, email: false } as const;
    expect(MessageCard.parse(card)).toEqual(card);
    const moved = { kind: 'moved', channel: 'email', url: null, sentTo: 's***@b.co' } as const;
    expect(MessageCard.parse(moved)).toEqual(moved);
    const notice = Message.parse({
      id: ID,
      conversationId: ID,
      seq: 4,
      author: 'system',
      body: 'This chat continues by email.',
      inReplyTo: null,
      disclosure: null,
      notice: 'This chat continues by email.',
      noticeKind: 'handoff_moved',
      card: moved,
      authorName: null,
      language: 'en',
      createdAt: AT,
    });
    expect(notice.card).toEqual(moved);
    expect(WidgetConfigResponse.shape.handoff.parse(undefined)).toEqual({
      telegram: false,
      email: false,
    });
  });
});
