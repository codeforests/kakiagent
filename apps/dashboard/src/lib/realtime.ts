import { RealtimeEvent, type ConversationSummary } from '@kaki/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * The dashboard WebSocket (ADR-017). Events patch the conversation list; on every
 * (re)connect the list is refetched, because pub/sub only notifies and Postgres is
 * the record.
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
          return;
        }
        const event = RealtimeEvent.safeParse(data);
        if (event.success && event.data.type === 'conversation') {
          const summary = event.data.conversation;
          queryClient.setQueryData<{ conversations: ConversationSummary[] }>(
            ['conversations'],
            (old) => {
              const rest = (old?.conversations ?? []).filter((c) => c.id !== summary.id);
              return { conversations: [summary, ...rest] };
            },
          );
        }
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
