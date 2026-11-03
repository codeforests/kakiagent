import { describe, expect, it } from 'vitest';
import {
  CorrectionContext,
  ProposedChange,
  StaffMessageBody,
  SuggestionRequest,
  SuggestionResponse,
} from './index.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = '2026-11-02T09:00:00.000Z';
const suggestion = {
  id: ID,
  text: 'Our chocolate cake is $48.',
  facts: [{ id: ID, type: 'product', label: 'Chocolate cake', status: 'approved' }],
  forMessageId: ID,
  forSeq: 3,
  language: 'en',
  createdAt: AT,
};

describe('suggested replies (FEAT-045 §3)', () => {
  it('a response holds exactly one of a suggestion and a reason', () => {
    expect(SuggestionResponse.safeParse({ suggestion, none: null }).success).toBe(true);
    expect(SuggestionResponse.safeParse({ suggestion: null, none: 'unavailable' }).success).toBe(
      true,
    );
    expect(SuggestionResponse.safeParse({ suggestion: null, none: null }).success).toBe(false);
    expect(SuggestionResponse.safeParse({ suggestion, none: 'no_checked_answer' }).success).toBe(
      false,
    );
    expect(SuggestionResponse.safeParse({ suggestion: null, none: 'maybe' }).success).toBe(false);
  });

  it('the request is empty and strict; a staff message may cite a suggestion', () => {
    expect(SuggestionRequest.safeParse({}).success).toBe(true);
    expect(SuggestionRequest.safeParse({ text: 'x' }).success).toBe(false);
    const body = { body: 'Hi', clientMessageId: 'abcdefgh' };
    expect(StaffMessageBody.safeParse(body).success).toBe(true);
    expect(StaffMessageBody.safeParse({ ...body, suggestionId: ID }).success).toBe(true);
    expect(StaffMessageBody.safeParse({ ...body, suggestionId: 'nope' }).success).toBe(false);
    expect(StaffMessageBody.safeParse({ ...body, draft: 'x' }).success).toBe(false);
  });

  it('a reply_edit proposal carries only the suggestion ID (D6)', () => {
    expect(ProposedChange.parse({ kind: 'reply_edit', suggestionId: ID })).toEqual({
      kind: 'reply_edit',
      suggestionId: ID,
    });
    expect(ProposedChange.safeParse({ kind: 'reply_edit' }).success).toBe(false);
  });

  it('the item context shows the question, the draft and the sent reply', () => {
    const replyEdit = {
      question: 'How much is the cake?',
      suggested: 'It is $48.',
      sent: 'It is $48, and we deliver.',
      suggestedAt: AT,
      sentAt: AT,
      facts: suggestion.facts,
    };
    const base = { coaching: null, conversation: null, gap: null };
    expect(CorrectionContext.safeParse({ ...base, replyEdit }).success).toBe(true);
    expect(CorrectionContext.safeParse({ ...base, replyEdit: null }).success).toBe(true);
  });
});
