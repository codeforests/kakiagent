import { describe, expect, it } from 'vitest';
import {
  AlertEvent,
  LeadConsentRecord,
  LeadWithdrawBody,
  Message,
  MessageCard,
  WithdrawBody,
  WithdrawResponse,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';

describe('consent withdrawal contracts (FEAT-051 §3)', () => {
  it('round-trips the withdraw card, the notice and the response', () => {
    const card = { kind: 'withdraw', offers: true } as const;
    expect(MessageCard.parse(card)).toEqual(card);
    expect(MessageCard.safeParse({ kind: 'withdraw' }).success).toBe(false);
    const notice = {
      id: ID,
      conversationId: ID,
      seq: 4,
      author: 'system',
      body: 'Done.',
      inReplyTo: null,
      disclosure: null,
      notice: 'Done.',
      noticeKind: 'consent_withdrawn',
      authorName: null,
      language: 'en',
      createdAt: AT,
    };
    const res = { status: 'withdrawn', notice: Message.parse(notice) };
    expect(WithdrawResponse.parse(res)).toEqual(res);
    const again = { status: 'already_withdrawn', notice: null };
    expect(WithdrawResponse.parse(again)).toEqual(again);
    expect(WithdrawResponse.safeParse({ status: 'gone', notice: null }).success).toBe(false);
  });

  it('the bodies are strict and refuse an unknown scope', () => {
    expect(WithdrawBody.parse({ messageId: ID, scope: 'all' })).toEqual({
      messageId: ID,
      scope: 'all',
    });
    expect(WithdrawBody.safeParse({ messageId: ID, scope: 'everything' }).success).toBe(false);
    expect(WithdrawBody.safeParse({ messageId: ID, scope: 'all', contactId: ID }).success).toBe(
      false,
    );
    expect(LeadWithdrawBody.parse({ scope: 'marketing' })).toEqual({ scope: 'marketing' });
    expect(LeadWithdrawBody.safeParse({ scope: 'all', recordedBy: ID }).success).toBe(false);
  });

  it('a withdrawal record has no wording and may name its recorder; the alert event exists', () => {
    const rec = {
      id: ID,
      purpose: 'enquiry',
      decision: 'withdrawn',
      at: AT,
      channel: 'dashboard',
      conversationId: null,
      wording: null,
      recordedBy: 'Ken Tan',
    } as const;
    expect(LeadConsentRecord.parse(rec)).toEqual(rec);
    expect(AlertEvent.parse('consent_withdrawn')).toBe('consent_withdrawn');
  });
});
