import type { Replay, ReplayNextResponse, ReplayTurn } from '@kaki/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import {
  authorLabel,
  completeLine,
  driveReplay,
  effectSentences,
  failureOf,
  hasPending,
  limitCaption,
  limitHeader,
  progressText,
  withTurn,
} from './replay.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const turn = (index: number, over: Partial<ReplayTurn> = {}): ReplayTurn => ({
  messageId: id(index + 1),
  index,
  question: `Question ${index + 1}`,
  askedAt: '2026-10-20T03:00:00.000Z',
  original: [],
  status: 'pending',
  replayed: null,
  effects: [],
  factsChanged: null,
  ...over,
});

const done = (index: number, factsChanged: boolean | null = false): ReplayTurn =>
  turn(index, {
    status: 'done',
    factsChanged,
    replayed: {
      id: id(100 + index),
      seq: index,
      author: 'agent',
      kind: 'replay',
      text: 'A cake is S$42.',
      includeUnreviewed: false,
      createdAt: '2026-10-24T03:00:00.000Z',
      explainer: null,
      correction: null,
    },
  });

const replay = (turns: ReplayTurn[]): Replay => ({
  id: id(900),
  conversationId: id(901),
  includeUnreviewed: false,
  createdAt: '2026-10-24T03:00:00.000Z',
  totalQuestions: turns.length,
  turns,
});

describe('replay display', () => {
  it('counts done turns in the progress text', () => {
    expect(progressText([done(0), done(1), turn(2)])).toBe('Replaying 2 of 3…');
    expect(progressText([turn(0)])).toBe('Replaying 0 of 1…');
  });

  it('says "first 20 of N" only over the limit', () => {
    expect(limitCaption(20)).toBeNull();
    expect(limitCaption(34)).toBe('Only the first 20 of 34 questions are replayed.');
    expect(limitHeader(5)).toBeNull();
    expect(limitHeader(34)).toBe('The first 20 of 34 questions.');
  });

  it('counts answers that use different facts', () => {
    expect(completeLine([done(0, true), done(1, false), done(2, null)])).toBe(
      'Replay complete. 1 answer uses different facts.',
    );
    expect(completeLine([done(0, true), done(1, true)])).toBe(
      'Replay complete. 2 answers use different facts.',
    );
    expect(completeLine([done(0)])).toBe('Replay complete. 0 answers use different facts.');
  });

  it('writes a sentence only for effects that would change the conversation live', () => {
    expect(
      effectSentences([
        { task: 'crisis', outcome: 'done' },
        { task: 'out_of_scope', outcome: 'refused' },
        { task: 'capture_lead', outcome: 'unhandled' },
      ]),
    ).toEqual(['Live, this would also flag the conversation. Nothing was flagged in this replay.']);
    expect(effectSentences([{ task: 'abuse', outcome: 'done' }])).toHaveLength(1);
    expect(effectSentences([{ task: 'crisis', outcome: 'refused' }])).toEqual([]);
  });

  it('labels the original replies', () => {
    expect(authorLabel('agent', 'Kaki')).toBe('Kaki · AI');
    expect(authorLabel('staff', 'Kaki')).toBe('Staff');
    expect(authorLabel('system', 'Kaki')).toBe('System');
  });

  it('swaps in an answered turn', () => {
    const r = replay([turn(0), turn(1)]);
    const next = withTurn(r, done(0));
    expect(next.turns[0]!.status).toBe('done');
    expect(next.turns[1]!.status).toBe('pending');
    expect(hasPending(next)).toBe(true);
    expect(hasPending(withTurn(next, done(1)))).toBe(false);
  });
});

describe('driveReplay', () => {
  const answer = (index: number, remaining: number): ReplayNextResponse => ({
    turn: done(index),
    remaining,
  });

  it('answers one turn per call until none remain', async () => {
    const next = vi
      .fn<() => Promise<ReplayNextResponse>>()
      .mockResolvedValueOnce(answer(0, 2))
      .mockResolvedValueOnce(answer(1, 1))
      .mockResolvedValueOnce(answer(2, 0));
    const onTurn = vi.fn();
    expect(await driveReplay(next, onTurn, () => false)).toEqual({ kind: 'done' });
    expect(next).toHaveBeenCalledTimes(3);
    expect(onTurn.mock.calls.map(([r]) => r.turn.index)).toEqual([0, 1, 2]);
  });

  it('stops on pause after the call in flight lands', async () => {
    let paused = false;
    const next = vi.fn(async () => {
      paused = true; // the owner presses Pause while this call runs
      return answer(0, 5);
    });
    const onTurn = vi.fn();
    expect(await driveReplay(next, onTurn, () => paused)).toEqual({ kind: 'paused' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledTimes(1);
  });

  it('makes no call when paused before starting', async () => {
    const next = vi.fn();
    expect(await driveReplay(next, vi.fn(), () => true)).toEqual({ kind: 'paused' });
    expect(next).not.toHaveBeenCalled();
  });

  it('stops on an error and says which kind', async () => {
    const fail = (err: unknown) =>
      driveReplay(
        vi
          .fn<() => Promise<ReplayNextResponse>>()
          .mockResolvedValueOnce(answer(0, 3))
          .mockRejectedValueOnce(err),
        vi.fn(),
        () => false,
      );
    expect(await fail(new ApiError(429, 'rate_limited', 'slow down'))).toEqual({
      kind: 'error',
      failure: 'rate_limited',
    });
    expect(await fail(new ApiError(404, 'conversation_gone', 'gone'))).toEqual({
      kind: 'error',
      failure: 'conversation_gone',
    });
    expect(await fail(new ApiError(500, 'internal', 'boom'))).toEqual({
      kind: 'error',
      failure: 'failed',
    });
    expect(await fail(new TypeError('network'))).toEqual({ kind: 'error', failure: 'failed' });
  });

  it('treats 409 replay_complete as done', async () => {
    const next = vi.fn().mockRejectedValue(new ApiError(409, 'replay_complete', 'done'));
    expect(await driveReplay(next, vi.fn(), () => false)).toEqual({ kind: 'done' });
  });

  it('classifies a not-found replay as a plain failure', () => {
    expect(failureOf(new ApiError(404, 'not_found', 'nope'))).toBe('failed');
  });
});
