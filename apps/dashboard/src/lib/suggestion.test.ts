import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  isStale,
  latestVisitorSeq,
  needsReplaceConfirm,
  noneText,
  retryMinutes,
  sendBody,
  suggestFailure,
} from './suggestion.ts';

describe('suggested replies (FEAT-045)', () => {
  it('says why there is no draft', () => {
    expect(noneText('no_checked_answer')).toBe(
      "The assistant couldn't write a reply that passes its checks. Write your own.",
    );
    expect(noneText('unavailable')).toBe(
      "The assistant doesn't have the facts to answer this. Write your own.",
    );
  });

  it('finds the newest visitor message and goes stale after it', () => {
    const msgs = [
      { author: 'visitor' as const, seq: 1 },
      { author: 'agent' as const, seq: 2 },
      { author: 'visitor' as const, seq: 3 },
      { author: 'staff' as const, seq: 4 },
    ];
    expect(latestVisitorSeq(msgs)).toBe(3);
    expect(latestVisitorSeq([{ author: 'agent', seq: 1 }])).toBeNull();
    expect(isStale({ forSeq: 3 }, 3)).toBe(false);
    expect(isStale({ forSeq: 1 }, 3)).toBe(true);
    expect(isStale({ forSeq: 1 }, null)).toBe(false);
  });

  it('carries the suggestion ID only while the text came from a draft', () => {
    expect(sendBody('Hi', 'client-123', 's-1')).toEqual({
      body: 'Hi',
      clientMessageId: 'client-123',
      suggestionId: 's-1',
    });
    expect(sendBody('Hi', 'client-123', null)).toEqual({
      body: 'Hi',
      clientMessageId: 'client-123',
    });
  });

  it('asks before replacing typed text, never an unedited draft or an empty box', () => {
    expect(needsReplaceConfirm('', null)).toBe(false);
    expect(needsReplaceConfirm('  ', 'draft')).toBe(false);
    expect(needsReplaceConfirm('draft', 'draft')).toBe(false);
    expect(needsReplaceConfirm('draft, edited', 'draft')).toBe(true);
    expect(needsReplaceConfirm('my own words', null)).toBe(true);
  });

  it('maps refusals to the dock states', () => {
    expect(suggestFailure(new ApiError(409, 'ai_paused', 'x'))).toEqual({ kind: 'paused' });
    expect(suggestFailure(new ApiError(409, 'not_owner', 'x'))).toEqual({ kind: 'not_owner' });
    expect(suggestFailure(new ApiError(409, 'nothing_to_answer', 'x'))).toEqual({
      kind: 'alert',
      tone: 'info',
      text: "There's no customer message to answer yet.",
    });
    expect(
      suggestFailure(new ApiError(429, 'too_many_suggestions', 'x', { retryAfterS: 1500 })),
    ).toEqual({
      kind: 'alert',
      tone: 'warning',
      text: "That's a lot of suggestions for one chat. Try again in 25 min.",
      retryAfterS: 1500,
    });
    expect(suggestFailure(new Error('network'))).toEqual({
      kind: 'alert',
      tone: 'danger',
      text: "Couldn't get a suggestion.",
    });
  });

  it('rounds the wait up to whole minutes', () => {
    expect(retryMinutes(1)).toBe(1);
    expect(retryMinutes(61)).toBe(2);
    expect(retryMinutes(3600)).toBe(60);
  });
});
