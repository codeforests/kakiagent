import type { AiStatus } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { pausedSince, pillState } from './ai-status.ts';

const base: AiStatus = {
  paused: false,
  pausedAt: null,
  liveChannels: 0,
  fallback: { en: 'Our team will get back to you.', zh: '我们的团队会尽快回复您。' },
};

describe('pillState (D8)', () => {
  it('is not_live with no live channel and the AI running', () => {
    expect(pillState(base)).toBe('not_live');
  });
  it('is live with at least one live channel', () => {
    expect(pillState({ ...base, liveChannels: 1 })).toBe('live');
    expect(pillState({ ...base, liveChannels: 3 })).toBe('live');
  });
  it('is paused whenever paused, live channels or not', () => {
    const pausedAt = '2026-10-28T06:05:00.000Z';
    expect(pillState({ ...base, paused: true, pausedAt, liveChannels: 2 })).toBe('paused');
    expect(pillState({ ...base, paused: true, pausedAt })).toBe('paused');
  });
});

describe('pausedSince', () => {
  it('formats the pause time in SGT', () => {
    expect(pausedSince({ ...base, paused: true, pausedAt: '2026-10-28T06:05:00.000Z' })).toBe(
      'Paused since 2:05 pm, 28 Oct',
    );
  });
  it('is null while running', () => {
    expect(pausedSince(base)).toBeNull();
  });
});
