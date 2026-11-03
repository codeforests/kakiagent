import type { StaffMessageBody, Suggestion, SuggestionNone, ThreadMessage } from '@kaki/contracts';
import { ApiError } from './api.ts';

/** Suggest a reply's display rules (FEAT-045 ui-design SCR-APP-015). */

export const SUGGESTION_LABEL = 'AI suggestion · checked against your facts · edit before sending';
export const SUGGESTION_CAPTION =
  "The suggestion only uses approved facts. Anything you add yourself isn't checked.";
export const PAUSED_HELP = "The assistant is paused, so it can't suggest replies.";
export const STALE_TEXT = 'The customer wrote again after this suggestion.';

/** Why there's no draft, as the dock's info alert. */
export function noneText(none: SuggestionNone): string {
  switch (none) {
    case 'no_checked_answer':
      return "The assistant couldn't write a reply that passes its checks. Write your own.";
    case 'unavailable':
      return "The assistant doesn't have the facts to answer this. Write your own.";
  }
}

/** The newest visitor message's seq in the loaded thread; null when there is none. */
export function latestVisitorSeq(messages: readonly Pick<ThreadMessage, 'author' | 'seq'>[]) {
  let latest: number | null = null;
  for (const m of messages)
    if (m.author === 'visitor' && (latest === null || m.seq > latest)) latest = m.seq;
  return latest;
}

/** The customer wrote again after the draft was made. */
export const isStale = (s: Pick<Suggestion, 'forSeq'>, latestSeq: number | null): boolean =>
  latestSeq !== null && s.forSeq < latestSeq;

/** The send request: carries the suggestion while the text came from one. */
export function sendBody(
  text: string,
  clientMessageId: string,
  suggestionId: string | null,
): StaffMessageBody {
  return suggestionId
    ? { body: text, clientMessageId, suggestionId }
    : { body: text, clientMessageId };
}

/** Ask before replacing the box: only text that isn't the unedited draft. */
export const needsReplaceConfirm = (text: string, draft: string | null): boolean =>
  text.trim() !== '' && text !== draft;

/** Whole minutes to wait, at least one. */
export const retryMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

export type SuggestFailure =
  | { kind: 'paused' }
  | { kind: 'not_owner' }
  | { kind: 'alert'; tone: 'info' | 'warning' | 'danger'; text: string; retryAfterS?: number };

/** How a failed suggestion request shows (ui-design SCR-APP-015, Errors). */
export function suggestFailure(err: unknown): SuggestFailure {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === 'ai_paused') return { kind: 'paused' };
    if (err.status === 409 && err.code === 'not_owner') return { kind: 'not_owner' };
    if (err.status === 409 && err.code === 'nothing_to_answer')
      return { kind: 'alert', tone: 'info', text: "There's no customer message to answer yet." };
    if (err.status === 429) {
      const raw = Number(err.details.retryAfterS);
      const seconds = Number.isFinite(raw) && raw > 0 ? raw : 3600;
      return {
        kind: 'alert',
        tone: 'warning',
        text: `That's a lot of suggestions for one chat. Try again in ${retryMinutes(seconds)} min.`,
        retryAfterS: seconds,
      };
    }
  }
  return { kind: 'alert', tone: 'danger', text: "Couldn't get a suggestion." };
}
