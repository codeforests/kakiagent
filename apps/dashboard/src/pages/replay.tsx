import type { Replay, ReplayCandidate, ReplayTurn } from '@kaki/contracts';
import { Button, EmptyState, ErrorState, FormDialog } from '@kaki/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { askHref, relativeTime, useBotName } from '../lib/coach.ts';
import {
  authorLabel,
  completeLine,
  dateLabel,
  driveReplay,
  effectSentences,
  hasPending,
  limitCaption,
  limitHeader,
  progressText,
  RATE_LIMIT_PAUSE_MS,
  timeLabel,
  withTurn,
  type ReplayFailure,
} from '../lib/replay.ts';
import { AnswerExplainer } from './coach-chat.tsx';
import { CoachPanelButton } from './quick-coach-panel.tsx';

function ReplayForbidden() {
  return (
    <EmptyState title="You don't have access to Replay">
      Only the Owner and Admins can replay conversations.
    </EmptyState>
  );
}

function ReplayHead() {
  return (
    <>
      <Link className="back-link" to="/coach">
        Coach
      </Link>
      <h1 className="page-title">Replay a conversation</h1>
      <p className="page-lede">
        See how your assistant would answer a real conversation today, next to what the customer
        got.
      </p>
    </>
  );
}

const CHANNEL_LABEL: Record<string, string> = { widget: 'Website chat' };

/**
 * `/coach/replay`: SCR-APP-031 picking (AGT-17, UC-04 4b; FEAT-028 ui-design). Past
 * conversations, newest first; picking one asks before replaying it.
 */
export function ReplayPickPage() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<ReplayCandidate | null>(null);
  const [unreviewed, setUnreviewed] = useState(false);
  const toggleId = useId();

  const list = useInfiniteQuery({
    queryKey: ['replay-candidates'],
    queryFn: ({ pageParam }) => api.replayCandidates(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const start = useMutation({
    mutationFn: (c: ReplayCandidate) =>
      api.startReplay({ conversationId: c.id, includeUnreviewed: unreviewed }),
    onSuccess: (res) => navigate(`/coach/replay/${res.replay.id}`, { state: { start: true } }),
  });

  if (list.error instanceof ApiError && list.error.status === 403) return <ReplayForbidden />;

  const pick = (c: ReplayCandidate) => {
    start.reset();
    setUnreviewed(false);
    setPicked(c);
  };
  const conversations = list.data?.pages.flatMap((p) => p.conversations) ?? [];
  const nothing = start.error instanceof ApiError && start.error.code === 'nothing_to_replay';
  const limit = picked ? limitCaption(picked.questions) : null;

  return (
    <div className="replay-page">
      <ReplayHead />
      {list.isPending && (
        <ul className="source-list" aria-busy="true" aria-label="Loading conversations">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load conversations."
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.isSuccess && conversations.length === 0 && (
        <EmptyState
          title="No conversations to replay yet"
          action={<Link to="/coach">Practise in Coach instead</Link>}
        >
          When customers chat with your assistant, their conversations appear here.
        </EmptyState>
      )}
      {conversations.length > 0 && (
        <ul className="source-list" aria-label="Past conversations">
          {conversations.map((c) => (
            <li key={c.id} className="source-row replay-row" data-testid="replay-candidate">
              <button type="button" className="replay-row__pick" onClick={() => pick(c)}>
                <span className="replay-row__who">
                  Website visitor · {CHANNEL_LABEL[c.channel] ?? c.channel}
                  {c.flagged && <span className="chip chip--warning">Flagged</span>}
                </span>
                <span className="replay-row__question">{c.firstQuestion}</span>
                <span className="source-row__meta">
                  {c.questions} question{c.questions === 1 ? '' : 's'} ·{' '}
                  {relativeTime(c.lastMessageAt)}
                </span>
              </button>
              {c.lastReplayId && (
                <span className="source-row__meta">
                  Replayed before · <Link to={`/coach/replay/${c.lastReplayId}`}>View</Link>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      )}

      <FormDialog
        open={picked !== null}
        onOpenChange={(o) => !o && setPicked(null)}
        title="Replay this conversation?"
        busy={start.isPending}
      >
        <div className="kaki-dialog__body">
          <p>
            Your assistant re-answers each customer question with your current facts. Nothing is
            sent to the customer and nothing in the conversation changes.
          </p>
          {limit && <p className="field__help">{limit}</p>}
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
        </div>
        {start.isError && (
          <div className="alert alert--danger" role="alert">
            <p>
              {nothing
                ? 'This conversation has no customer questions to replay.'
                : "Couldn't start the replay. Try again."}
            </p>
          </div>
        )}
        <div className="kaki-dialog__actions">
          <Button variant="ghost" onClick={() => setPicked(null)} disabled={start.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => picked && start.mutate(picked)}
            disabled={start.isPending || nothing}
            aria-busy={start.isPending || undefined}
          >
            {start.isPending ? 'Starting…' : 'Replay'}
          </Button>
        </div>
      </FormDialog>
    </div>
  );
}

type Mode = 'idle' | 'running' | 'pausing' | ReplayFailure;

/**
 * `/coach/replay/:id`: SCR-APP-031 replaying and comparison. Opened right after starting,
 * it drives `…/next` one question at a time; reopened with questions left, it waits for
 * "Continue replay".
 */
export function ReplayPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const botName = useBotName();
  const autoStart = (location.state as { start?: boolean } | null)?.start === true;
  const [mode, setMode] = useState<Mode>('idle');
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const stop = useRef(false);
  const started = useRef(false);

  const key = ['replay', id] as const;
  const replay = useQuery({
    queryKey: key,
    queryFn: () => api.replay(id),
    staleTime: Infinity,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  });
  const data = replay.data?.replay;

  const run = () => {
    if (!data) return;
    stop.current = false;
    setFailedAt(null);
    setMode('running');
    void driveReplay(
      () => api.replayNext(id),
      (res) =>
        queryClient.setQueryData(key, (old: { replay: Replay } | undefined) =>
          old ? { replay: withTurn(old.replay, res.turn) } : old,
        ),
      () => stop.current,
    ).then((result) => {
      if (result.kind === 'error') {
        const current = queryClient.getQueryData<{ replay: Replay }>(key);
        setFailedAt(current?.replay.turns.find((t) => t.status === 'pending')?.messageId ?? null);
        setMode(result.failure);
        if (result.failure === 'rate_limited') {
          setCooling(true);
          setTimeout(() => setCooling(false), RATE_LIMIT_PAUSE_MS);
        }
      } else setMode('idle');
    });
  };

  useEffect(() => {
    if (data && autoStart && !started.current && hasPending(data)) {
      started.current = true;
      run();
    }
    // Starts once, when the replay first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data !== undefined]);
  // Leaving the page stops the loop after the call in flight.
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const err = replay.error;
  if (err instanceof ApiError && err.status === 403) return <ReplayForbidden />;
  if (mode === 'conversation_gone')
    return (
      <div className="replay-page">
        <ReplayHead />
        <EmptyState
          title="This conversation was deleted, so its replay is gone."
          action={<Link to="/coach/replay">Back to replays</Link>}
        />
      </div>
    );
  if (err instanceof ApiError && (err.status === 404 || err.status === 422))
    return (
      <div className="replay-page">
        <ReplayHead />
        <EmptyState
          title="This replay isn't available."
          action={<Link to="/coach/replay">Back to replays</Link>}
        />
      </div>
    );

  const pending = data ? hasPending(data) : false;
  const running = mode === 'running' || mode === 'pausing';
  const answering = running ? data?.turns.find((t) => t.status === 'pending')?.messageId : null;
  const limit = data ? limitHeader(data.totalQuestions) : null;

  return (
    <div className="replay-page">
      <ReplayHead />
      {replay.isPending && (
        <div className="coach-skeleton" aria-busy="true" aria-label="Loading the replay">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="coach-skeleton__bubble" />
          ))}
        </div>
      )}
      {replay.isError && (
        <ErrorState
          title="Couldn't load the replay."
          action={
            <Button variant="secondary" onClick={() => void replay.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && (
        <>
          <div className="replay-strip">
            <p className="replay-strip__title">
              {data.includeUnreviewed
                ? 'Replaying with your current facts, including unreviewed facts'
                : 'Replaying with your current facts'}
              {data.includeUnreviewed && <span className="chip chip--warning">Unreviewed</span>}
            </p>
            <p className="field__help">
              {data.turns[0] && `Conversation of ${dateLabel(data.turns[0].askedAt)}. `}
              {limit && `${limit} `}
              Opening-hours answers use today's hours.
            </p>
            {pending && running && (
              <div className="replay-strip__progress">
                <div
                  className="progress"
                  role="progressbar"
                  aria-label="Replay progress"
                  aria-valuemin={0}
                  aria-valuemax={data.turns.length}
                  aria-valuenow={data.turns.filter((t) => t.status === 'done').length}
                >
                  <div
                    className="progress__bar"
                    style={{
                      width: `${(100 * data.turns.filter((t) => t.status === 'done').length) / data.turns.length}%`,
                    }}
                  />
                </div>
                <span>{progressText(data.turns)}</span>
              </div>
            )}
            {!pending && <p className="replay-strip__done">{completeLine(data.turns)}</p>}
            {mode === 'rate_limited' && (
              <div className="alert alert--warning" role="alert">
                <p>Replaying quickly. Wait a minute, then continue.</p>
              </div>
            )}
            {pending && (
              <div>
                <Button
                  variant={running ? 'ghost' : 'primary'}
                  disabled={mode === 'pausing' || (!running && cooling)}
                  onClick={() => {
                    if (running) {
                      stop.current = true;
                      setMode('pausing');
                    } else run();
                  }}
                >
                  {running ? 'Pause' : 'Continue replay'}
                </Button>
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {running ? progressText(data.turns) : pending ? '' : completeLine(data.turns)}
            </div>
          </div>
          <ol className="replay-turns">
            {data.turns.map((t) => (
              <TurnRow
                key={t.messageId}
                turn={t}
                total={data.turns.length}
                botName={botName}
                answering={t.messageId === answering}
                failed={mode === 'failed' && t.messageId === failedAt}
                onRetry={run}
                unreviewed={data.includeUnreviewed}
              />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** design.md §4.6 `answer-compare`: one customer question, what they got and what it says now. */
function TurnRow({
  turn,
  total,
  botName,
  answering,
  failed,
  onRetry,
  unreviewed,
}: {
  turn: ReplayTurn;
  total: number;
  botName: string;
  answering: boolean;
  failed: boolean;
  onRetry: () => void;
  unreviewed: boolean;
}) {
  const label = `Question ${turn.index + 1} of ${total}`;
  return (
    <li className="answer-compare" aria-label={label} data-testid="replay-turn">
      <div className="coach-bubble coach-bubble--visitor">
        <span className="coach-bubble__who">Customer · {timeLabel(turn.askedAt)}</span>
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
      {(turn.factsChanged || turn.replayed) && (
        <div className="answer-compare__foot">
          {turn.factsChanged && <span className="chip chip--accent">Uses different facts</span>}
          {turn.replayed && (
            <CoachPanelButton
              label="Teach a fix"
              prefill={turn.question}
              unreviewed={unreviewed}
              narrowHref={askHref(turn.question, unreviewed)}
            />
          )}
        </div>
      )}
    </li>
  );
}
