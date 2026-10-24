import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { relativeTime, useBotName } from '../lib/coach.ts';
import { useReviewSummary } from '../lib/review.ts';
import { CoachChat } from './coach-chat.tsx';

export function CoachForbidden() {
  return (
    <EmptyState title="You don't have access to Coach">
      Only the Owner and Admins can coach the assistant.
    </EmptyState>
  );
}

/**
 * `/coach`: SCR-APP-030 (AGT-17, ONB-05; FEAT-027 ui-design). Practice chats on the left,
 * the coach chat on the right; `?session=` opens a chat, `?ask=` prefills the composer
 * (the quick panel on narrow screens) and `?unreviewed=1` starts with unreviewed facts on.
 */
export function CoachPage() {
  const [search, setSearch] = useSearchParams();
  const sessionId = search.get('session');
  const ask = search.get('ask') ?? '';
  const botName = useBotName();
  // A new key only when the owner picks another chat, so creating one on the first send
  // keeps the composer and the pending turn.
  const [thread, setThread] = useState(() => sessionId ?? 'new');
  const [listOpen, setListOpen] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['coach-sessions'],
    queryFn: ({ pageParam }) => api.coachSessions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const opened = useQuery({
    queryKey: ['coach-session', sessionId ?? ''],
    queryFn: () => api.coachSession(sessionId!),
    enabled: sessionId !== null,
    staleTime: Infinity,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });

  if (list.error instanceof ApiError && list.error.status === 403) return <CoachForbidden />;

  const open = (id: string | null) => {
    setThread(id ?? `new-${Date.now()}`);
    setListOpen(false);
    setSearch(id ? { session: id } : {});
  };
  const sessions = list.data?.pages.flatMap((p) => p.sessions) ?? [];
  const missing = opened.error instanceof ApiError && opened.error.status === 404;

  return (
    <div className={`coach-page${listOpen ? ' coach-page--list-open' : ''}`}>
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Coach</h1>
          <p className="page-lede">Practise with your assistant and teach it what's changed.</p>
        </div>
        <button
          type="button"
          className="icon-button coach-page__chats"
          aria-expanded={listOpen}
          aria-controls="coach-chats"
          onClick={() => setListOpen((v) => !v)}
        >
          Chats
        </button>
      </div>
      <div className="coach-layout">
        <nav id="coach-chats" className="coach-list" aria-label="Practice chats">
          <Button variant="secondary" onClick={() => open(null)}>
            New chat
          </Button>
          {list.isLoading && (
            <div className="skeleton-list" aria-busy="true" aria-label="Loading practice chats" />
          )}
          {list.isError && (
            <ErrorState
              title="Couldn't load your practice chats."
              action={
                <Button variant="secondary" onClick={() => void list.refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          <ul className="coach-list__items">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="coach-list__item"
                  aria-current={s.id === sessionId ? 'true' : undefined}
                  onClick={() => open(s.id)}
                >
                  <span className="coach-list__title">{s.title ?? 'New chat'}</span>
                  <span className="coach-list__meta">{relativeTime(s.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button
              variant="ghost"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              Show older chats
            </Button>
          )}
        </nav>
        <section className="coach-main" aria-label="Chat">
          {missing ? (
            <EmptyState
              title="This chat isn't available."
              action={<Button onClick={() => open(null)}>Start a new chat</Button>}
            />
          ) : (
            <CoachChat
              key={thread}
              origin="coach"
              sessionId={sessionId}
              onSession={(id) => setSearch({ session: id }, { replace: true })}
              botName={botName}
              initialText={ask}
              initialUnreviewed={search.get('unreviewed') === '1'}
              autoFocus={ask !== ''}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * `/setup/test`: SCR-APP-010 (partial), the setup's "test your assistant" step (ONB-05;
 * FEAT-027 ui-design). FEAT-035 adds the wizard frame.
 */
export function SetupTestPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const botName = useBotName();
  const summary = useReviewSummary();
  const forbidden = summary.error instanceof ApiError && summary.error.status === 403;
  if (forbidden) return <CoachForbidden />;
  return (
    <div className="coach-page coach-setup">
      <p className="page-lede">Step 4 of the setup</p>
      <h1 className="page-title">Test your assistant</h1>
      <p className="page-lede">
        Ask the questions your customers ask. If an answer is wrong, tell your assistant what's
        right.
      </p>
      {summary.data?.approvedInUse === 0 && (
        <div className="alert alert--info" role="status">
          <p>
            You haven't approved any facts yet, so your assistant can't answer much. Approve facts
            in the previous step, or include unreviewed facts to try them out.{' '}
            <Link to="/setup/review">Back to review</Link>
          </p>
        </div>
      )}
      <CoachChat
        origin="setup"
        sessionId={sessionId}
        onSession={setSessionId}
        botName={botName}
        suggestions="always"
      />
      <div className="review-setup__footer">
        <Button asChild>
          <Link to="/">Continue</Link>
        </Button>
        <p className="review-setup__caption">You can keep practising any time in Coach.</p>
      </div>
    </div>
  );
}
