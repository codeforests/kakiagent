import type {
  CoachMessage,
  CoachOrigin,
  CoachSession,
  Correction,
  Explainer,
} from '@kaki/contracts';
import { Button, EmptyState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  changeSubject,
  confirmedLine,
  diffRows,
  explainerSummary,
  reasonSentences,
  visitorsLine,
} from '../lib/coach.ts';
import { TYPE_LABEL } from '../lib/facts.ts';

/**
 * The coach chat (FEAT-027 ui-design, cross-screen): one component for SCR-APP-030,
 * SCR-APP-010 and the quick coach panel. Answers arrive whole (no streaming, D1); a
 * taught correction is a proposal the owner confirms here, never applied silently.
 */

type Detail = { session: CoachSession; messages: CoachMessage[] };
const detailKey = (id: string) => ['coach-session', id] as const;

export interface CoachChatProps {
  origin: CoachOrigin;
  /** Null until the first send creates the session. */
  sessionId: string | null;
  onSession?: (id: string) => void;
  botName: string;
  /** The composer's starting text, not sent (the quick panel's prefill). */
  initialText?: string;
  initialUnreviewed?: boolean;
  /** `always`: suggestion chips above the composer (SCR-APP-010); `empty`: only in an empty thread. */
  suggestions?: 'empty' | 'always';
  onConfirmed?: (c: Correction) => void;
  autoFocus?: boolean;
}

function sendError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429)
    return "You're sending questions quickly. Wait a minute, then try again.";
  return "Couldn't get an answer. Try again.";
}

export function CoachChat({
  origin,
  sessionId,
  onSession,
  botName,
  initialText = '',
  initialUnreviewed = false,
  suggestions = 'empty',
  onConfirmed,
  autoFocus = false,
}: CoachChatProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialText);
  const [unreviewed, setUnreviewed] = useState(initialUnreviewed);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const toggleId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);

  const detail = useQuery({
    queryKey: detailKey(sessionId ?? ''),
    queryFn: () => api.coachSession(sessionId!),
    enabled: sessionId !== null,
    staleTime: Infinity,
  });
  const hints = useQuery({ queryKey: ['coach-suggestions'], queryFn: api.coachSuggestions });
  const messages = detail.data?.messages ?? [];

  useEffect(() => {
    if (autoFocus) composer.current?.focus();
  }, [autoFocus]);

  const append = (id: string, add: CoachMessage[]) =>
    queryClient.setQueryData<Detail>(detailKey(id), (d) =>
      d ? { ...d, messages: [...d.messages, ...add] } : d,
    );

  const turn = useMutation({
    mutationFn: async (q: string) => {
      let id = sessionId;
      if (!id) {
        const { session } = await api.createCoachSession(origin);
        queryClient.setQueryData<Detail>(detailKey(session.id), { session, messages: [] });
        id = session.id;
        onSession?.(id);
      }
      return { id, res: await api.coachTurn(id, { text: q, includeUnreviewed: unreviewed }) };
    },
    onMutate: (q) => {
      setPending(q);
      setError(null);
      setText('');
    },
    onSuccess: ({ id, res }) => {
      append(id, [res.question, res.answer]);
      setAnnounce(res.answer.text);
      void queryClient.invalidateQueries({ queryKey: ['coach-sessions'] });
    },
    onError: (err, q) => {
      setText(q);
      setError({ text: q, message: sendError(err) });
    },
    onSettled: () => setPending(null),
  });

  const send = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || turn.isPending) return;
    turn.mutate(trimmed);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(text);
    }
  };

  const updateCorrection = (c: Correction, add: CoachMessage[] = []) => {
    if (!sessionId) return;
    queryClient.setQueryData<Detail>(detailKey(sessionId), (d) =>
      d
        ? {
            ...d,
            messages: [
              ...d.messages.map((m) => (m.correction?.id === c.id ? { ...m, correction: c } : m)),
              ...add,
            ],
          }
        : d,
    );
  };

  const shown = messages.filter((m) => m.kind !== 'after');
  const chips = hints.data?.questions ?? [];
  const empty = sessionId === null || (detail.isSuccess && messages.length === 0);

  return (
    <div className="coach-chat">
      <div className="alert alert--info coach-chat__banner">
        <p>This is a practice chat. Customers never see it, and it isn't counted in your usage.</p>
      </div>

      <div className="coach-thread" role="log" aria-label="Practice chat">
        {detail.isLoading && sessionId !== null && (
          <div className="coach-skeleton" aria-hidden="true">
            <span className="coach-skeleton__bubble" />
            <span className="coach-skeleton__bubble coach-skeleton__bubble--owner" />
            <span className="coach-skeleton__bubble" />
          </div>
        )}
        {empty && !pending && suggestions === 'empty' && (
          <EmptyState title="Ask your assistant something">
            Try a question your customers often ask.
          </EmptyState>
        )}
        {empty && !pending && suggestions === 'empty' && chips.length > 0 && (
          <Suggestions questions={chips} onPick={send} disabled={turn.isPending} />
        )}
        {shown.map((m) =>
          m.author === 'owner' ? (
            <OwnerBubble key={m.id} text={m.text} />
          ) : m.kind === 'proposal' && m.correction ? (
            <ProposalCard
              key={m.id}
              message={m}
              thread={messages}
              botName={botName}
              onDecided={(c, after) => {
                updateCorrection(c, after ? [after] : []);
                if (c.status === 'accepted') onConfirmed?.(c);
              }}
              onRefresh={() =>
                void queryClient.invalidateQueries({ queryKey: detailKey(sessionId ?? '') })
              }
            />
          ) : (
            <AgentBubble key={m.id} message={m} botName={botName} />
          ),
        )}
        {pending && (
          <>
            <OwnerBubble text={pending} />
            <div className="coach-bubble coach-bubble--agent coach-bubble--typing">
              <span className="spinner" aria-hidden="true" /> Your assistant is answering…
            </div>
          </>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {pending ? 'Your assistant is answering…' : announce}
      </div>

      {suggestions === 'always' && chips.length > 0 && (
        <Suggestions questions={chips} onPick={send} disabled={turn.isPending} />
      )}

      <div className="coach-composer">
        <div className="coach-composer__toggle">
          <button
            type="button"
            role="switch"
            className="toggle"
            aria-checked={unreviewed}
            aria-labelledby={`${toggleId}-label`}
            aria-describedby={`${toggleId}-help`}
            onClick={() => setUnreviewed((v) => !v)}
          >
            <span className="toggle__thumb" />
          </button>
          <div>
            <span id={`${toggleId}-label`} className="field__label">
              Include facts you haven't reviewed
            </span>
            <p id={`${toggleId}-help`} className="field__help">
              Answers may then differ from what customers get.
            </p>
          </div>
        </div>
        <label className="sr-only" htmlFor={`${toggleId}-composer`}>
          Message
        </label>
        <textarea
          id={`${toggleId}-composer`}
          ref={composer}
          className="input input--area coach-composer__input"
          rows={2}
          maxLength={1000}
          placeholder="Ask what a customer would ask, or tell your assistant what's changed"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={turn.isPending}
        />
        <Button
          onClick={() => send(text)}
          disabled={turn.isPending || !text.trim()}
          aria-busy={turn.isPending || undefined}
        >
          {turn.isPending ? <span className="spinner" aria-hidden="true" /> : null}
          Send
        </Button>
      </div>
      {error && (
        <div className="alert alert--danger" role="alert">
          <p>
            {error.message}{' '}
            <Button variant="ghost" className="kaki-btn--sm" onClick={() => send(error.text)}>
              Retry
            </Button>
          </p>
        </div>
      )}
    </div>
  );
}

function Suggestions({
  questions,
  onPick,
  disabled,
}: {
  questions: string[];
  onPick: (q: string) => void;
  disabled: boolean;
}) {
  return (
    <ul className="coach-suggestions" aria-label="Suggested questions">
      {questions.map((q) => (
        <li key={q}>
          <button
            type="button"
            className="coach-suggestion"
            onClick={() => onPick(q)}
            disabled={disabled}
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}

function OwnerBubble({ text }: { text: string }) {
  return (
    <div className="coach-bubble coach-bubble--owner">
      <span className="coach-bubble__who">You</span>
      <p className="coach-bubble__text">{text}</p>
    </div>
  );
}

function AgentBubble({ message, botName }: { message: CoachMessage; botName: string }) {
  return (
    <div className="coach-bubble coach-bubble--agent">
      <span className="coach-bubble__who">{botName} · coaching</span>
      <p className="coach-bubble__text">{message.text}</p>
      {message.explainer && <AnswerExplainer explainer={message.explainer} />}
    </div>
  );
}

/** design.md §4.6 `answer-explainer`: collapsed to one line, built from the pipeline's codes (D3). */
export function AnswerExplainer({ explainer }: { explainer: Explainer }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const visitors = visitorsLine(explainer);
  return (
    <div className="answer-explainer">
      <button
        type="button"
        className="answer-explainer__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {explainerSummary(explainer)} · Why?
      </button>
      {visitors?.tone === 'caption' && <p className="answer-explainer__caption">{visitors.text}</p>}
      {visitors && visitors.tone !== 'caption' && (
        <div className={`alert alert--${visitors.tone}`}>
          <p>{visitors.text}</p>
        </div>
      )}
      <div id={id} hidden={!open} className="answer-explainer__body">
        {explainer.facts.length > 0 && (
          <ul className="answer-explainer__facts" aria-label="Facts considered">
            {explainer.facts.map((f) => (
              <li key={f.id}>
                <Link
                  to={`/knowledge/facts/${f.id}`}
                  className={`fact-chip${f.used ? ' fact-chip--used' : ''}`}
                >
                  <span className="fact-chip__type">{TYPE_LABEL[f.type]}</span> {f.label}
                  <span className="sr-only">{f.used ? ' (used)' : ' (considered, not used)'}</span>
                </Link>
                {f.status === 'needs_review' && (
                  <span className="chip chip--warning">Unreviewed</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <ul className="answer-explainer__why">
          {reasonSentences(explainer).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type DecisionError = 'correction_stale' | 'invalid_correction' | 'failed';

function ProposalCard({
  message,
  thread,
  botName,
  onDecided,
  onRefresh,
}: {
  message: CoachMessage;
  thread: CoachMessage[];
  botName: string;
  onDecided: (c: Correction, after: CoachMessage | null) => void;
  onRefresh: () => void;
}) {
  const c = message.correction!;
  const [problem, setProblem] = useState<DecisionError | null>(null);
  // Past visitor questions the accepted fix replays on SCR-APP-022 (FEAT-018 ui-design).
  const [replayQuestions, setReplayQuestions] = useState(0);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (c.status === 'open') confirmRef.current?.focus();
    // Only when the proposal first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = useMutation({
    mutationFn: async (
      action: 'confirm' | 'dismiss',
    ): Promise<{ correction: Correction; after: CoachMessage | null; replayQuestions?: number }> =>
      action === 'confirm'
        ? api.confirmCorrection(c.id)
        : { ...(await api.dismissCorrection(c.id)), after: null },
    onSuccess: (r) => {
      setReplayQuestions(r.replayQuestions ?? 0);
      onDecided(r.correction, r.after);
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'correction_closed') {
        // Decided elsewhere: refresh the card from the session.
        setProblem(null);
        onRefresh();
        return;
      }
      setProblem(
        err instanceof ApiError &&
          (err.code === 'correction_stale' || err.code === 'invalid_correction')
          ? err.code
          : 'failed',
      );
    },
  });

  const rows = diffRows(c.change);
  const factLink = c.change.kind === 'edit_fact' ? `/knowledge/facts/${c.change.factId}` : null;

  if (c.status === 'dismissed')
    return (
      <div className="coach-decided coach-decided--neutral" role="status">
        Not changed. You can find it later in Review › Corrections.
      </div>
    );

  if (c.status !== 'open') {
    const after = thread.find((m) => m.kind === 'after' && m.correction?.id === c.id) ?? null;
    const before =
      [...thread]
        .reverse()
        .find(
          (m) =>
            m.seq < message.seq &&
            m.author === 'agent' &&
            (m.kind === 'answer' || m.kind === 'after'),
        ) ?? null;
    return (
      <div className="coach-confirmed">
        <div className="coach-decided coach-decided--success" role="status">
          {confirmedLine(c.change)} {factLink && <Link to={factLink}>View the fact</Link>}
          {replayQuestions > 0 && (
            <>
              {' '}
              <Link to={`/review/corrections/${c.id}`}>
                See {replayQuestions} past {replayQuestions === 1 ? 'answer' : 'answers'}
              </Link>
            </>
          )}
        </div>
        {before && after && (
          <div className="coach-before-after">
            <div>
              <h3 className="coach-before-after__label">Before</h3>
              <AgentBubble message={before} botName={botName} />
            </div>
            <div>
              <h3 className="coach-before-after__label">Now</h3>
              <AgentBubble message={after} botName={botName} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="card coach-proposal" aria-labelledby={titleId}>
      <h3 id={titleId} className="coach-proposal__title">
        Proposed change
      </h3>
      <p className="coach-proposal__subject">{changeSubject(c.change)}</p>
      <dl className="coach-diff">
        {rows.map((r) => (
          <div key={r.label} className="coach-diff__row">
            <dt>{r.label}</dt>
            <dd>
              {r.was !== null && (
                <span className="coach-diff__was">
                  <span className="coach-diff__tag">Was</span> <s>{r.was}</s>
                </span>
              )}
              <span className="coach-diff__now">
                <span className="coach-diff__tag">Now</span> {r.now}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {problem === 'correction_stale' && (
        <div className="alert alert--warning" role="alert">
          <p>This fact changed since I suggested this. Ask again to get a new suggestion.</p>
        </div>
      )}
      {problem === 'invalid_correction' && (
        <div className="alert alert--danger" role="alert">
          <p>
            This change isn't valid any more. Edit the fact instead.{' '}
            {factLink && <Link to={factLink}>Edit the fact</Link>}
          </p>
        </div>
      )}
      {problem === 'failed' && (
        <div className="alert alert--danger" role="alert">
          <p>Couldn't save this change. Try again.</p>
        </div>
      )}
      {problem !== 'correction_stale' && problem !== 'invalid_correction' && (
        <>
          <div className="coach-proposal__actions">
            <Button
              ref={confirmRef}
              onClick={() => decide.mutate('confirm')}
              disabled={decide.isPending}
              aria-busy={(decide.isPending && decide.variables === 'confirm') || undefined}
            >
              {decide.isPending && decide.variables === 'confirm'
                ? 'Confirming…'
                : 'Confirm change'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => decide.mutate('dismiss')}
              disabled={decide.isPending}
            >
              Not now
            </Button>
          </div>
          <p className="coach-proposal__caption">Customers get this as soon as you confirm.</p>
        </>
      )}
    </section>
  );
}
