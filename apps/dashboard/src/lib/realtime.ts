import {
  RealtimeEvent,
  type ConversationList,
  type ConversationSummary,
  type ConversationThread,
  type Message,
} from '@kaki/contracts';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AI_STATUS_KEY } from './ai-status.ts';
import { appendMessage, applySummary, COUNTS_KEY, threadKey, type InboxFilter } from './inbox.ts';

export type LiveState = 'connecting' | 'live' | 'offline';

/** Visitor messages seen live, for the list's polite announcement (throttled by the page). */
export const inboxEvents = new EventTarget();

type ListData = InfiniteData<ConversationList, unknown>;

/** A changed conversation patches every cached list view and the open thread. */
export function onConversation(queryClient: QueryClient, summary: ConversationSummary) {
  for (const [key] of queryClient.getQueriesData<ListData>({ queryKey: ['conversations'] })) {
    const [, view, channel] = key as [string, InboxFilter['view'], string];
    const filter: InboxFilter = { view, channel: channel === 'widget' ? 'widget' : null };
    queryClient.setQueryData<ListData>(key, (old) => applySummary(old, summary, filter));
  }
  void queryClient.invalidateQueries({ queryKey: COUNTS_KEY });
  const thread = queryClient.getQueryData<ConversationThread>(threadKey(summary.id));
  // A state or flag change needs the new version and divider: refetch the thread.
  if (
    thread &&
    (thread.conversation.status !== summary.status ||
      thread.conversation.flaggedAt !== summary.flaggedAt)
  )
    void queryClient.invalidateQueries({ queryKey: threadKey(summary.id) });
}

/** A stored message appends to the cached thread; an AI answer also refetches it for its fact chips. */
export function onMessage(queryClient: QueryClient, message: Message) {
  const key = threadKey(message.conversationId);
  const thread = queryClient.getQueryData<ConversationThread>(key);
  if (thread) {
    queryClient.setQueryData<ConversationThread>(key, (old) => appendMessage(old, message));
    if (message.author === 'agent') void queryClient.invalidateQueries({ queryKey: key });
  }
  if (message.author === 'visitor') inboxEvents.dispatchEvent(new Event('visitor-message'));
}

/**
 * The dashboard WebSocket (ADR-017). Events patch the inbox lists and the open thread;
 * on every (re)connect lists, counts and threads are refetched, because pub/sub only
 * notifies and Postgres is the record.
 */
export function useInboxSocket(): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      socket = new WebSocket(url);
      socket.onmessage = (e) => {
        const data = JSON.parse(String(e.data)) as { type: string };
        if (data.type === 'ready') {
          attempt = 0;
          setState('live');
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          void queryClient.invalidateQueries({ queryKey: COUNTS_KEY });
          void queryClient.invalidateQueries({ queryKey: ['conversation'] });
          return;
        }
        const event = RealtimeEvent.safeParse(data);
        if (!event.success) return;
        // The kill switch changed (FEAT-057): a nudge to refetch the status.
        if (event.data.type === 'ai_status')
          void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
        else if (event.data.type === 'conversation')
          onConversation(queryClient, event.data.conversation);
        else if (event.data.type === 'message') onMessage(queryClient, event.data.message);
      };
      socket.onclose = (e) => {
        if (closed) return;
        setState('offline');
        // Refused for the session (4401) or the workspace (4403): `me` routes the user
        // to sign in or create one, so don't retry (FEAT-005 §3.6).
        if (e.code === 4401 || e.code === 4403) {
          void queryClient.invalidateQueries({ queryKey: ['me'] });
          return;
        }
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [queryClient]);

  return state;
}
