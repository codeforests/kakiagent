import type {
  ConversationSummary,
  ConversationThread,
  Me,
  StaffMessageBody,
  Suggestion,
} from '@kaki/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import { appendMessage, dockMode, ownerText, takeoverErrorText, threadKey } from './inbox.ts';
import { onConversation } from './realtime.ts';
import { noneText, suggestFailure } from './suggestion.ts';

export type DockAlert = {
  tone: 'info' | 'warning' | 'danger';
  text: string;
  retry?: () => void;
  /** A suggestion's notice (FEAT-045): dismissed by typing or the next suggest. */
  suggest?: boolean;
};
export type DockSummary = ConversationSummary & { version: number };

export const MAX_REPLY = 4000;
export const newClientId = () => crypto.randomUUID();

/**
 * The dock's actions (FEAT-043 §5.5): take over, hand back, reply, request, take from;
 * FEAT-045 adds suggest (alone, or after taking over).
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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestPaused, setSuggestPaused] = useState(false);
  const [suggestBlockedFor, setSuggestBlockedFor] = useState<number | null>(null);
  const [suggestAfterTakeover, setSuggestAfterTakeover] = useState(false);
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
      setSuggestion(null);
      setFocusNext('composer');
      toast('You took over. The assistant is paused here.');
    },
    onError: (err, from) => {
      setSuggestAfterTakeover(false);
      refused(err, {
        tone: 'danger',
        text: "Couldn't take over.",
        retry: () => takeOver.mutate(from),
      });
    },
  });
  const handBack = useMutation({
    mutationFn: () => api.handBack(c.id, c.version),
    onMutate: () => setAlert(null),
    onSuccess: (res) => {
      onConversation(queryClient, res.conversation);
      refresh();
      setFocusNext('takeover');
      setSuggestion(null);
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
    mutationFn: (v: StaffMessageBody) => api.sendStaffMessage(c.id, v),
    onMutate: () => setAlert(null),
    onSuccess: (res, v) => {
      queryClient.setQueryData<ConversationThread>(threadKey(c.id), (old) =>
        appendMessage(old, res.message),
      );
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (v.suggestionId) setSuggestion(null);
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

  const suggest = useMutation({
    mutationFn: () => api.suggestReply(c.id),
    onMutate: () => setAlert((a) => (a?.suggest ? null : a)),
    onSuccess: (res) => {
      setSuggestPaused(false);
      if (res.suggestion) return setSuggestion(res.suggestion);
      if (res.none) setAlert({ tone: 'info', text: noneText(res.none), suggest: true });
      setFocusNext('composer');
    },
    onError: (err) => {
      const f = suggestFailure(err);
      if (f.kind === 'paused') return setSuggestPaused(true);
      if (f.kind === 'not_owner')
        return refused(err, { tone: 'danger', text: "Couldn't get a suggestion." });
      if (f.retryAfterS) setSuggestBlockedFor(f.retryAfterS * 1000);
      setAlert({
        tone: f.tone,
        text: f.text,
        suggest: true,
        ...(f.tone === 'danger' ? { retry: () => suggest.mutate() } : {}),
      });
    },
  });
  // The 429 lock lifts at Retry-After.
  useEffect(() => {
    if (suggestBlockedFor === null) return;
    const timer = setTimeout(() => setSuggestBlockedFor(null), suggestBlockedFor);
    return () => clearTimeout(timer);
  }, [suggestBlockedFor]);
  // From the takeover bar: take over first, then draft (UC-23 3–4).
  const takeOverAndSuggest = () => {
    setSuggestAfterTakeover(true);
    takeOver.mutate(undefined, {
      onSuccess: () => {
        setSuggestAfterTakeover(false);
        suggest.mutate();
      },
    });
  };

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
    suggest,
    takeOverAndSuggest,
    /** The bar's Suggest a reply started the take-over in flight. */
    suggestAfterTakeover: suggestAfterTakeover && takeOver.isPending,
    suggestion,
    clearSuggestion: () => setSuggestion(null),
    suggestPaused,
    suggestBlocked: suggestBlockedFor !== null,
    dismissSuggestNotice: () => setAlert((a) => (a?.suggest ? null : a)),
  };
}

export type DockActions = ReturnType<typeof useDockActions>;
