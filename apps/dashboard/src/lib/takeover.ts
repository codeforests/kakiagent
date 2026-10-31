import type { ConversationSummary, ConversationThread, Me } from '@kaki/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import { appendMessage, dockMode, ownerText, takeoverErrorText, threadKey } from './inbox.ts';
import { onConversation } from './realtime.ts';

export type DockAlert = { tone: 'warning' | 'danger'; text: string; retry?: () => void };
export type DockSummary = ConversationSummary & { version: number };

export const MAX_REPLY = 4000;
export const newClientId = () => crypto.randomUUID();

/**
 * The dock's actions (FEAT-043 §5.5): take over, hand back, reply, request, take from.
 * Lives in the pane so the phone's "More actions" menu can hand back too, and so a
 * refused reply's draft outlives the composer.
 */
export function useDockActions(
  conversation: DockSummary | undefined,
  me: Me | undefined,
  toast: (t: string) => void,
) {
  const queryClient = useQueryClient();
  // Called before the thread loads (hooks run unconditionally); actions only fire after.
  const c = conversation ?? { id: '', version: 0, owner: null, status: 'ai' as const };
  const mode = dockMode(c, me);
  const [alert, setAlert] = useState<DockAlert | null>(null);
  const [focusNext, setFocusNext] = useState<'composer' | 'takeover' | null>(null);
  const [lostDraft, setLostDraft] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: threadKey(c.id) });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };
  const refused = (err: unknown, generic: DockAlert) => {
    if (err instanceof ApiError && err.status === 409) {
      const text = takeoverErrorText(err.code, err.details);
      setAlert({ tone: 'warning', text: text ?? generic.text });
      const conv = err.details.conversation as ConversationSummary | undefined;
      if (conv) onConversation(queryClient, conv);
      refresh();
      return;
    }
    setAlert(generic);
  };

  const takeOver = useMutation({
    mutationFn: (from?: string) => api.takeOver(c.id, c.version, from),
    onMutate: () => setAlert(null),
    onSuccess: (res) => {
      onConversation(queryClient, res.conversation);
      refresh();
      setLostDraft(null);
      setFocusNext('composer');
      toast('You took over. The assistant is paused here.');
    },
    onError: (err, from) =>
      refused(err, {
        tone: 'danger',
        text: "Couldn't take over.",
        retry: () => takeOver.mutate(from),
      }),
  });
  const handBack = useMutation({
    mutationFn: () => api.handBack(c.id, c.version),
    onMutate: () => setAlert(null),
    onSuccess: (res) => {
      onConversation(queryClient, res.conversation);
      refresh();
      setFocusNext('takeover');
      toast('Handed back to the assistant');
    },
    onError: (err) =>
      refused(err, {
        tone: 'danger',
        text: "Couldn't hand back.",
        retry: () => handBack.mutate(),
      }),
  });
  const request = useMutation({
    mutationFn: () => api.requestHandover(c.id),
    onMutate: () => setAlert(null),
    onSuccess: () => {
      setRequested(true);
      toast(`${ownerText(c.owner, me?.user.id)} has been asked to hand over.`);
      refresh();
    },
    onError: (err) =>
      refused(err, {
        tone: 'danger',
        text: "Couldn't send the request.",
        retry: () => request.mutate(),
      }),
  });
  // "Request sent" for 60 s, then the button can be pressed again.
  useEffect(() => {
    if (!requested) return;
    const timer = setTimeout(() => setRequested(false), 60_000);
    return () => clearTimeout(timer);
  }, [requested]);
  // A new owner (or none) resets the request and any stale alert's context.
  const ownerId = c.owner?.userId ?? null;
  const [seenOwner, setSeenOwner] = useState(ownerId);
  if (seenOwner !== ownerId) {
    setSeenOwner(ownerId);
    setRequested(false);
  }

  const reply = useMutation({
    mutationFn: (v: { body: string; clientMessageId: string }) =>
      api.sendStaffMessage(c.id, v.body, v.clientMessageId),
    onMutate: () => setAlert(null),
    onSuccess: (res) => {
      queryClient.setQueryData<ConversationThread>(threadKey(c.id), (old) =>
        appendMessage(old, res.message),
      );
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err, v) => {
      if (err instanceof ApiError && err.status === 409) setLostDraft(v.body);
      refused(err, {
        tone: 'danger',
        text: "Couldn't send. Your reply is still here.",
        retry: () => reply.mutate(v),
      });
    },
  });

  return {
    mode,
    alert,
    focusNext,
    clearFocus: () => setFocusNext(null),
    lostDraft,
    clearLostDraft: () => setLostDraft(null),
    requested,
    takeOver,
    handBack,
    request,
    reply,
  };
}

export type DockActions = ReturnType<typeof useDockActions>;
