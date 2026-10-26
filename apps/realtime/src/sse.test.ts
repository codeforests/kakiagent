import type { Message } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { sseFrame } from './sse.js';

const message: Message = {
  id: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  seq: 4,
  author: 'agent',
  body: 'Yes, we have it.',
  createdAt: '2026-10-19T00:00:00.000Z',
  inReplyTo: '00000000-0000-4000-8000-000000000003',
  disclosure: null,
  notice: null,
  noticeKind: null,
  language: null,
};

describe('sseFrame', () => {
  it('gives a stored message its sequence number as the event ID', () => {
    expect(sseFrame({ type: 'message', message })).toBe(
      `id: 4\nevent: message\ndata: ${JSON.stringify({ type: 'message', message })}\n\n`,
    );
  });

  it('sends a segment without an ID, so Last-Event-ID stays on durable messages', () => {
    const segment = {
      type: 'segment' as const,
      turnId: message.inReplyTo!,
      seq: 0,
      text: 'Yes, we have it.',
    };
    const frame = sseFrame(segment);
    expect(frame).toBe(`event: segment\ndata: ${JSON.stringify(segment)}\n\n`);
    expect(frame).not.toMatch(/^id:/m);
  });
});
