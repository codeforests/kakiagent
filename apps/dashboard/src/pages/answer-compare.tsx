import type { CoachMessage, OriginalReply, ReplayEffect } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import type { ReactNode } from 'react';
import { authorLabel, effectSentences, timeLabel } from '../lib/replay.ts';
import { AnswerExplainer } from './coach-chat.tsx';

/** The parts of a replayed question `answer-compare` shows (FEAT-028 and FEAT-018 turns). */
export interface CompareTurn {
  question: string;
  askedAt: string;
  original: OriginalReply[];
  replayed: CoachMessage | null;
  effects: ReplayEffect[];
}

/**
 * design.md §4.6 `answer-compare`: one customer question, what they got and what it says
 * now. Shared by SCR-APP-031 (FEAT-028) and SCR-APP-022 (FEAT-018); `foot` holds each
 * screen's chips and actions.
 */
export function AnswerCompare({
  turn,
  label,
  botName,
  answering,
  failed,
  onRetry,
  asked,
  foot,
}: {
  turn: CompareTurn;
  label: string;
  botName: string;
  answering: boolean;
  failed: boolean;
  onRetry: () => void;
  /** The question bubble's time line; defaults to the time it was asked. */
  asked?: string;
  foot?: ReactNode;
}) {
  return (
    <li className="answer-compare" aria-label={label} data-testid="replay-turn">
      <div className="coach-bubble coach-bubble--visitor">
        <span className="coach-bubble__who">Customer · {asked ?? timeLabel(turn.askedAt)}</span>
        <p className="coach-bubble__text">{turn.question}</p>
      </div>
      <div className="answer-compare__columns">
        <section className="answer-compare__column" data-testid="replay-original">
          <h3 className="answer-compare__heading">What the customer got</h3>
          {turn.original.length === 0 && <p className="field__help">No one answered this.</p>}
          {turn.original.map((r, i) => (
            <div key={i} className="coach-bubble coach-bubble--original">
              <span className="coach-bubble__who">{authorLabel(r.author, botName)}</span>
              <p className="coach-bubble__text">{r.text}</p>
            </div>
          ))}
        </section>
        <section className="answer-compare__column" data-testid="replay-now">
          <h3 className="answer-compare__heading">What your assistant says now</h3>
          {turn.replayed ? (
            <div className="coach-bubble coach-bubble--agent">
              <span className="coach-bubble__who">{botName} · replay</span>
              <p className="coach-bubble__text">{turn.replayed.text}</p>
              {turn.replayed.explainer && <AnswerExplainer explainer={turn.replayed.explainer} />}
            </div>
          ) : answering ? (
            <div className="coach-bubble coach-bubble--agent coach-bubble--typing">
              <span className="spinner" aria-hidden="true" /> Your assistant is answering…
            </div>
          ) : (
            <div className="coach-skeleton__bubble replay-waiting">
              <span className="sr-only">Waiting to replay</span>
            </div>
          )}
          {failed && (
            <div className="alert alert--danger" role="alert">
              <p>Couldn't replay this question.</p>
              <Button variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
        </section>
      </div>
      {effectSentences(turn.effects).map((s) => (
        <p key={s} className="field__help replay-effect">
          {s}
        </p>
      ))}
      {foot && <div className="answer-compare__foot">{foot}</div>}
    </li>
  );
}
