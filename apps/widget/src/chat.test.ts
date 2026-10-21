import type { Message } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { awaitingTurn, emptyChat, pendingText, withMessage, withSegment } from './chat.js';

const CONV = '00000000-0000-4000-8000-000000000000';
const msg = (
  id: string,
  seq: number,
  author: Message['author'],
  inReplyTo: string | null = null,
) => ({
  id,
  seq,
  conversationId: CONV,
  author,
  body: `${id} body`,
  inReplyTo,
  disclosure: null,
  notice: null,
  createdAt: new Date().toISOString(),
});

describe('chat state (SCR-WGT-002 replying)', () => {
  const asked = withMessage(emptyChat, msg('v1', 1, 'visitor'));

  it('grows one reply per turn from its segments, in seq order, without repeats', () => {
    let c = withSegment(asked, { turnId: 'v1', seq: 1, text: 'Second.' });
    c = withSegment(c, { turnId: 'v1', seq: 0, text: 'First.' });
    c = withSegment(c, { turnId: 'v1', seq: 0, text: 'First again.' });
    expect(pendingText(c, 'v1')).toBe('First. Second.');
    expect(awaitingTurn(c)).toBe('v1');
  });

  it('replaces the segments with the stored reply and ignores late segments', () => {
    let c = withSegment(asked, { turnId: 'v1', seq: 0, text: 'First.' });
    c = withMessage(c, msg('a1', 2, 'agent', 'v1'));
    expect(pendingText(c, 'v1')).toBeNull();
    expect(c.messages.map((m) => m.id)).toEqual(['v1', 'a1']);
    c = withSegment(c, { turnId: 'v1', seq: 1, text: 'Late.' });
    expect(pendingText(c, 'v1')).toBeNull();
    expect(awaitingTurn(c)).toBeNull();
  });

  it('shows a stored reply that arrives first (a reconnect) directly', () => {
    const c = withMessage(asked, msg('a1', 2, 'agent', 'v1'));
    expect(c.segments).toEqual({});
    expect(awaitingTurn(c)).toBeNull();
  });

  it('waits on the latest visitor message only', () => {
    let c = withMessage(asked, msg('a1', 2, 'system', 'v1'));
    c = withMessage(c, msg('v2', 3, 'visitor'));
    expect(awaitingTurn(c)).toBe('v2');
    expect(awaitingTurn(emptyChat)).toBeNull();
  });
});
