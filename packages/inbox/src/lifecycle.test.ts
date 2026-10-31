import { describe, expect, it } from 'vitest';
import {
  canTransition,
  IDLE_MS,
  idleMs,
  REOPEN_MS,
  reopenable,
  TRANSITIONS,
  type ConversationStatus,
} from './lifecycle.js';
import { staffNoticeText } from './ownership.js';
import { BadCursorError, decodeCursor, encodeCursor, toThreadEvent } from './views.js';

const ALL: ConversationStatus[] = ['ai', 'escalated', 'human', 'waiting_approval', 'closed'];

describe('the INB-08 edge table', () => {
  it('allows exactly these edges', () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed).toEqual([
      'ai→escalated',
      'ai→human',
      'ai→waiting_approval',
      'ai→closed',
      'escalated→ai',
      'escalated→human',
      'escalated→closed',
      'human→ai',
      'human→closed',
      'waiting_approval→ai',
      'waiting_approval→escalated',
      'waiting_approval→human',
      'waiting_approval→closed',
      'closed→ai',
    ]);
  });

  it('never allows a state to itself, and every open state can close', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
    for (const s of ALL.filter((x) => x !== 'closed')) expect(TRANSITIONS[s]).toContain('closed');
    expect(TRANSITIONS.closed).toEqual(['ai']);
  });
});

describe('idle and reopen windows', () => {
  it('widget 30 minutes, other channels 72 hours (mirrors inbox_queue_auto_close)', () => {
    expect(IDLE_MS.widget).toBe(30 * 60 * 1000);
    expect(idleMs('widget')).toBe(IDLE_MS.widget);
    expect(idleMs('email')).toBe(72 * 60 * 60 * 1000);
    expect(REOPEN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  const closed = (reason: string, ago: number) =>
    ({
      status: 'closed',
      closeReason: reason,
      closedAt: new Date(Date.now() - ago),
    }) as Parameters<typeof reopenable>[0];

  it('reopens only staff and inactivity closes within 7 days', () => {
    expect(reopenable(closed('staff', 60_000))).toBe(true);
    expect(reopenable(closed('inactive', REOPEN_MS - 60_000))).toBe(true);
    expect(reopenable(closed('inactive', REOPEN_MS + 60_000))).toBe(false);
    expect(reopenable(closed('visitor', 60_000))).toBe(false);
    expect(reopenable(closed('abuse', 60_000))).toBe(false);
    expect(reopenable({ ...closed('staff', 0), status: 'ai' })).toBe(false);
  });
});

describe('inbox cursor', () => {
  it('round-trips and keeps the microseconds', () => {
    const c = { at: '2026-10-31 09:13:09.123456+00', id: '0f8fad5b-d9cb-469f-a165-70867728950e' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('refuses anything malformed', () => {
    const bad = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const raw of [
      'not-base64-json',
      bad({ at: 'x', id: 'y' }),
      bad(['2026-10-31 09:13:09+00', 'not-a-uuid']),
      bad(["2026-10-31'; drop table x;--", '0f8fad5b-d9cb-469f-a165-70867728950e']),
    ])
      expect(() => decodeCursor(raw)).toThrow(BadCursorError);
  });
});

describe('takeover notices and dividers (FEAT-043 D4, §5.1)', () => {
  it('renders the joined and left notices per language, with the name or a fallback', () => {
    expect(staffNoticeText('staff_joined', 'Mei Ling', 'en')).toBe('Mei Ling joined the chat.');
    expect(staffNoticeText('staff_joined', null, 'en')).toBe('A team member joined the chat.');
    expect(staffNoticeText('staff_left', 'Mei Ling', 'en')).toBe(
      'Mei Ling left the chat. The assistant will keep helping you.',
    );
    expect(staffNoticeText('staff_joined', '美玲', 'zh')).toBe('美玲已加入对话。');
    expect(staffNoticeText('staff_left', null, 'zh')).toBe(
      '团队成员已离开对话，AI 助手会继续为您服务。',
    );
  });

  const USER = '00000000-0000-4000-8000-0000000000a1';
  const OTHER = '00000000-0000-4000-8000-0000000000b2';
  const row = (eventType: string, payload: unknown, related: string[] = []) => ({
    ts: new Date('2026-10-31T09:00:00Z'),
    eventType,
    actorType: 'user' as const,
    actorRef: USER,
    payload,
    subjectRefs: ['conversation:c', ...related],
  });

  it('names take-over, hand-back, take-from and requests', () => {
    const over = toThreadEvent(
      row('conversation.state_changed', { from: 'escalated', to: 'human', reason: null }),
    );
    expect(over).toMatchObject({
      from: 'escalated',
      to: 'human',
      reason: 'taken_over',
      subject: null,
    });
    const back = toThreadEvent(
      row('conversation.state_changed', { from: 'human', to: 'ai', reason: null }),
    );
    expect(back.reason).toBe('handed_back');
    const other = toThreadEvent(
      row('conversation.state_changed', { from: 'ai', to: 'escalated', reason: null }),
    );
    expect(other.reason).toBeNull();
    const from = toThreadEvent(
      row('conversation.owner_changed', { from: 'human', to: 'human', reason: 'taken_from' }, [
        `user:${OTHER}`,
      ]),
    );
    expect(from).toMatchObject({
      reason: 'taken_from',
      actor: { id: USER },
      subject: { id: OTHER },
    });
    const asked = toThreadEvent(
      row('conversation.handover_requested', { reason: 'handover_requested' }, [`user:${OTHER}`]),
    );
    expect(asked).toMatchObject({
      kind: 'state',
      from: null,
      to: null,
      reason: 'handover_requested',
      subject: { id: OTHER },
    });
  });
});
