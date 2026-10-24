import {
  REPLAY_LIMIT,
  type OriginalReply,
  type Replay,
  type ReplayEffect,
  type ReplayNextResponse,
  type ReplayTurn,
} from '@kaki/contracts';
import { ApiError } from './api.ts';

/** Replay display rules and the drive loop for SCR-APP-031 (FEAT-028 ui-design). */

/** "Replaying 3 of 12…" while the page drives `…/next`. */
export function progressText(turns: ReplayTurn[]): string {
  const done = turns.filter((t) => t.status === 'done').length;
  return `Replaying ${done} of ${turns.length}…`;
}

/** The picker dialog's caption when a conversation has more questions than are replayed. */
export function limitCaption(questions: number): string | null {
  return questions > REPLAY_LIMIT
    ? `Only the first ${REPLAY_LIMIT} of ${questions} questions are replayed.`
    : null;
}

/** The header strip's line for the same case. */
export function limitHeader(totalQuestions: number): string | null {
  return totalQuestions > REPLAY_LIMIT
    ? `The first ${REPLAY_LIMIT} of ${totalQuestions} questions.`
    : null;
}

/** "Replay complete. 2 answers use different facts." */
export function completeLine(turns: ReplayTurn[]): string {
  const k = turns.filter((t) => t.factsChanged === true).length;
  return `Replay complete. ${k} ${k === 1 ? 'answer uses' : 'answers use'} different facts.`;
}

const EFFECT_TEXT: Record<string, string> = {
  crisis: 'Live, this would also flag the conversation. Nothing was flagged in this replay.',
  abuse:
    "Live, this would also count towards ending the chat for abuse. The conversation wasn't changed in this replay.",
};

/**
 * One caption per effect that would change the conversation live (`done` only); a refused
 * out-of-scope task only changes the reply, which the column already shows.
 */
export function effectSentences(effects: ReplayEffect[]): string[] {
  const out = effects
    .filter((e) => e.outcome === 'done')
    .map((e) => EFFECT_TEXT[e.task])
    .filter((s): s is string => s !== undefined);
  return [...new Set(out)];
}

/** The original reply's label: "{bot name} · AI", "Staff" or "System". */
export function authorLabel(author: OriginalReply['author'], botName: string): string {
  switch (author) {
    case 'agent':
      return `${botName} · AI`;
    case 'staff':
      return 'Staff';
    case 'system':
      return 'System';
  }
}

/** The replay with one turn swapped for its answered version. */
export function withTurn(replay: Replay, turn: ReplayTurn): Replay {
  return {
    ...replay,
    turns: replay.turns.map((t) => (t.messageId === turn.messageId ? turn : t)),
  };
}

export const hasPending = (replay: Replay) => replay.turns.some((t) => t.status === 'pending');

/** How a failed `…/next` reads on the page. */
export type ReplayFailure = 'rate_limited' | 'conversation_gone' | 'failed';

export function failureOf(err: unknown): ReplayFailure {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'rate_limited';
    if (err.status === 404 && err.code === 'conversation_gone') return 'conversation_gone';
  }
  return 'failed';
}

export type DriveResult =
  { kind: 'done' } | { kind: 'paused' } | { kind: 'error'; failure: ReplayFailure };

/**
 * Drives the replay one `…/next` at a time (D1) until nothing is left, the owner pauses
 * (`shouldStop`, checked before each call; the call in flight still lands) or a call fails.
 * 409 `replay_complete` means another tab finished it, so it counts as done. SCR-APP-022's
 * correction replay (FEAT-018) drives its own `…/replay/next` the same way.
 */
export async function driveReplay<R extends { remaining: number } = ReplayNextResponse>(
  next: () => Promise<R>,
  onTurn: (res: R) => void,
  shouldStop: () => boolean,
): Promise<DriveResult> {
  while (!shouldStop()) {
    let res: R;
    try {
      res = await next();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'replay_complete')
        return { kind: 'done' };
      return { kind: 'error', failure: failureOf(err) };
    }
    onTurn(res);
    if (res.remaining === 0) return { kind: 'done' };
  }
  return { kind: 'paused' };
}

/** How long Continue stays disabled after a 429 (30 questions a minute per user). */
export const RATE_LIMIT_PAUSE_MS = 60_000;

const DATE_FMT = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});
const TIME_FMT = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

/** "21 Oct 2026", the conversation's date in the header strip. */
export const dateLabel = (iso: string) => DATE_FMT.format(new Date(iso));
/** "3:05 pm", a bubble's time. */
export const timeLabel = (iso: string) => TIME_FMT.format(new Date(iso));
