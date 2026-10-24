import { Replay } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';

const turn = {
  messageId: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a01',
  index: 0,
  question: 'How much is the pandan cake?',
  askedAt: '2026-10-20T03:00:00.000Z',
  original: [
    {
      author: 'agent',
      text: 'The pandan cake is S$28.',
      factIds: ['6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a02'],
      createdAt: '2026-10-20T03:00:05.000Z',
    },
  ],
  status: 'pending',
  replayed: null,
  effects: [],
  factsChanged: null,
};
const replay = {
  id: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a03',
  conversationId: '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a04',
  includeUnreviewed: false,
  createdAt: '2026-10-24T03:00:00.000Z',
  totalQuestions: 34,
  turns: [turn],
};

describe('Replay contract (FEAT-028 §3)', () => {
  it('parses a replay with a pending turn', () => {
    expect(Replay.parse(replay).turns[0]!.status).toBe('pending');
  });

  it('rejects a done turn without its replayed answer', () => {
    const bad = { ...replay, turns: [{ ...turn, status: 'done' }] };
    expect(Replay.safeParse(bad).success).toBe(false);
  });

  it('rejects an effect that is not a task code', () => {
    const bad = {
      ...replay,
      turns: [{ ...turn, effects: [{ task: 'Crisis flag!', outcome: 'done' }] }],
    };
    expect(Replay.safeParse(bad).success).toBe(false);
  });
});
