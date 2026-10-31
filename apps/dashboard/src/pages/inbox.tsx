import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { useInboxSocket } from '../lib/realtime.ts';

// FEAT-042's UI session replaces this skeleton list (SCR-APP-014).
const STATUS_LABEL = {
  ai: 'AI handling',
  escalated: 'Escalated',
  human: 'Human',
  waiting_approval: 'Waiting for approval',
  closed: 'Closed',
} as const;
const time = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

/**
 * The bare conversation list (plan §2): live over WebSocket. The real inbox,
 * SCR-APP-014 and SCR-APP-015, is built from FEAT-040 on.
 */
export function InboxPage() {
  const live = useInboxSocket();
  const list = useQuery({ queryKey: ['conversations'], queryFn: api.conversations });

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Inbox</h1>
        <span className={`live live--${live}`} data-testid="live-state">
          {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
      </div>
      {list.isPending && (
        <div className="skeleton-list" aria-busy="true" aria-label="Loading conversations" />
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load conversations"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.data && list.data.conversations.length === 0 && (
        <EmptyState title="No conversations yet">
          New widget chats appear here as soon as a visitor writes.
        </EmptyState>
      )}
      {list.data && list.data.conversations.length > 0 && (
        <ul
          className="conversation-list"
          aria-label="Conversations"
          data-testid="conversation-list"
        >
          {list.data.conversations.map((c) => (
            <li key={c.id} className="conversation-row" data-testid="conversation-row">
              <div className="conversation-row__main">
                <span className="conversation-row__title">Website visitor</span>
                <span className="conversation-row__preview" data-testid="conversation-preview">
                  {c.lastMessage ?? 'No messages yet'}
                </span>
              </div>
              <div className="conversation-row__meta">
                <span className={`badge badge--${c.status}`}>{STATUS_LABEL[c.status]}</span>
                <time dateTime={c.lastMessageAt}>{time.format(new Date(c.lastMessageAt))}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="sr-only" aria-live="polite">
        {list.data ? `${list.data.conversations.length} conversations` : ''}
      </div>
    </>
  );
}
