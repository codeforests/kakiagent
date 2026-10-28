import { describe, expect, it } from 'vitest';
import { AiStatusResponse, RealtimeEvent } from './index.js';

const status = {
  paused: true,
  pausedAt: '2026-10-28T05:00:00.000Z',
  liveChannels: 1,
  fallback: { en: 'Our team will get back to you.', zh: '我们的团队会尽快回复您。' },
};

describe('kill switch contract (FEAT-057 §3)', () => {
  it('parses a status and the ai_status event', () => {
    expect(AiStatusResponse.parse({ status })).toEqual({ status });
    expect(
      AiStatusResponse.parse({ status: { ...status, paused: false, pausedAt: null } }).status
        .pausedAt,
    ).toBeNull();
    expect(RealtimeEvent.parse({ type: 'ai_status', paused: false })).toEqual({
      type: 'ai_status',
      paused: false,
    });
  });

  it('rejects a negative channel count, a non-ISO time and an event without the flag', () => {
    expect(() => AiStatusResponse.parse({ status: { ...status, liveChannels: -1 } })).toThrow();
    expect(() =>
      AiStatusResponse.parse({ status: { ...status, pausedAt: 'yesterday' } }),
    ).toThrow();
    expect(() => RealtimeEvent.parse({ type: 'ai_status' })).toThrow();
  });
});
